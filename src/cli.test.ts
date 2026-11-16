import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run, type Io } from './commands.ts';
import { loadConfig } from './config.ts';
import { buildCall } from './openapi.ts';

type Call = { method: string; url: URL; headers: Record<string, string>; body: unknown };
const fail = (status: number, code: string, details?: object) => new Response(JSON.stringify({ error: { code, message: code, details } }), { status });
const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

/** A fake API: `routes` answers by "METHOD /path"; every call is recorded. */
async function harness(routes: Record<string, (c: Call) => unknown>, env: NodeJS.ProcessEnv = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'hermetica-cli-'));
  dirs.push(dir);
  const calls: Call[] = [];
  const out: string[] = [];
  const fakeFetch = (async (input: URL, init: RequestInit) => {
    const c: Call = { method: init.method ?? 'GET', url: input, headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    const h = routes[`${c.method} ${c.url.pathname}`];
    const r = h?.(c);
    if (r instanceof Response) return r;
    return h ? new Response(JSON.stringify(r), { status: 200 }) : new Response(JSON.stringify({ error: { code: 'not_found', message: 'Route not found' } }), { status: 404 });
  }) as unknown as typeof fetch;
  const slept: number[] = [];
  const opened: string[] = [];
  const io: Io = { env: { XDG_CONFIG_HOME: dir, ...env }, fetch: fakeFetch, out: (s) => out.push(s), sleep: async (ms) => { slept.push(ms); }, askKey: async () => 'hm_sk_asked', openUrl: (u) => opened.push(u) };
  return { io, calls, out, dir, slept, opened };
}

describe('hermetica cli', () => {
  it('login --paste verifies the key and stores it 0600; commands then use it', async () => {
    const h = await harness({ 'GET /v1/workspace': () => ({ name: 'Acme' }), 'GET /v1/profiles': () => ({ items: [{ id: 'p1' }], nextCursor: null }) });
    await run(['login', '--paste', '--url', 'https://api.example.test/'], h.io);
    expect(h.calls[0]!.headers.authorization).toBe('Bearer hm_sk_asked');
    expect(await loadConfig(h.io.env)).toEqual({ apiKey: 'hm_sk_asked', baseUrl: 'https://api.example.test' });
    if (process.platform !== 'win32') { // Windows has no POSIX modes (stat reports 0o666/0o777)
      expect((await stat(join(h.dir, 'hermetica', 'credentials'))).mode & 0o777).toBe(0o600);
      expect((await stat(join(h.dir, 'hermetica'))).mode & 0o777).toBe(0o700);
    }
    await run(['profiles', 'list', 'email=a@b.c'], h.io);
    expect(h.calls[1]!.url.href).toBe('https://api.example.test/v1/profiles?email=a%40b.c');
  });

  it('refuses a key that is not a secret key and stores nothing', async () => {
    const h = await harness({});
    await expect(run(['login', '--key', 'hm_pk_public'], h.io)).rejects.toThrow('secret key');
    expect(await loadConfig(h.io.env)).toBeNull();
  });

  it('writes send an idempotency key; send-test builds the seed body', async () => {
    const h = await harness({ 'POST /v1/campaigns/c1/test-send': () => ({ sent: 2 }) }, { HERMETICA_API_KEY: 'hm_sk_env' });
    await run(['send-test', 'campaign', 'c1', '--to', 'a@x.test, b@x.test'], h.io);
    expect(h.calls[0]!.body).toEqual({ emails: ['a@x.test', 'b@x.test'] });
    expect(h.calls[0]!.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('export follows cursors to the last page', async () => {
    const h = await harness({ 'GET /v1/lists': (c) => (c.url.searchParams.get('cursor') ? { items: [{ id: 'b' }], nextCursor: null } : { items: [{ id: 'a' }], nextCursor: 'a' }) }, { HERMETICA_API_KEY: 'hm_sk_env' });
    await run(['export', 'lists'], h.io);
    expect(h.out).toEqual(['{"id":"a"}', '{"id":"b"}']);
  });

  it('openapi passes any operation through, path params first', async () => {
    const spec = { paths: { '/v1/segments/{id}/members': { get: { operationId: 'getV1SegmentsByIdMembers' } } } };
    const h = await harness({ 'GET /openapi.json': () => spec, 'GET /v1/segments/s%201/members': () => ({ items: [] }) }, { HERMETICA_API_KEY: 'hm_sk_env' });
    await run(['openapi', 'getV1SegmentsByIdMembers', 'id=s 1', 'limit=5'], h.io);
    expect(h.calls[1]!.url.search).toBe('?limit=5');
    expect(() => buildCall({ id: 'x', method: 'GET', path: '/v1/x/{id}', summary: '' }, {})).toThrow('id=<value>');
  });

  it('mailboxes, leads, inbox and enrollments list and get against their routes; no create for read-only ones', async () => {
    const ok = () => ({ items: [], nextCursor: null });
    const h = await harness({
      'GET /v1/outbound/mailboxes': ok, 'GET /v1/outbound/mailboxes/m1': () => ({ id: 'm1' }), 'GET /v1/leads': ok, 'GET /v1/leads/l1': () => ({ id: 'l1' }),
      'GET /v1/outbound/inbox': ok, 'GET /v1/outbound/inbox/i1': () => ({ id: 'i1' }), 'GET /v1/workflows/s1/enrollments': ok, 'GET /v1/workflows/s1/enrollments/e1/steps': ok,
    }, { HERMETICA_API_KEY: 'hm_sk_env' });
    for (const argv of [['mailboxes', 'list'], ['mailboxes', 'get', 'm1'], ['leads', 'list', 'q=acme'], ['leads', 'get', 'l1'], ['inbox', 'list'], ['inbox', 'get', 'i1'], ['enrollments', 'list', 's1', 'state=active'], ['enrollments', 'get', 's1', 'e1']]) await run(argv, h.io);
    expect(h.calls.map((c) => `${c.method} ${c.url.pathname}${c.url.search}`)).toEqual([
      'GET /v1/outbound/mailboxes', 'GET /v1/outbound/mailboxes/m1', 'GET /v1/leads?q=acme', 'GET /v1/leads/l1',
      'GET /v1/outbound/inbox', 'GET /v1/outbound/inbox/i1', 'GET /v1/workflows/s1/enrollments?state=active', 'GET /v1/workflows/s1/enrollments/e1/steps',
    ]);
    expect(h.out[1]).toBe(JSON.stringify({ id: 'm1' }, null, 2));
    await expect(run(['leads', 'create', '--data', '{}'], h.io)).rejects.toThrow('Usage: hermetica leads list | get <id>');
    await expect(run(['enrollments', 'get', 's1'], h.io)).rejects.toThrow('Usage: hermetica enrollments');
  });

  it('reports API errors with the envelope message', async () => {
    const h = await harness({}, { HERMETICA_API_KEY: 'hm_sk_env' });
    await expect(run(['templates', 'get', 'nope'], h.io)).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });

  it('login runs the device flow: opens the browser, honours slow_down, stores the key without printing it', async () => {
    let polls = 0;
    const h = await harness({
      'POST /v1/auth/device': () => ({ deviceCode: 'dc1', userCode: 'ABCD-EFGH', verificationUrl: 'https://x.test/device', verificationUrlComplete: 'https://x.test/device?code=ABCD-EFGH', interval: 5, expiresIn: 600 }),
      'POST /v1/auth/device/token': () => (++polls === 1 ? fail(400, 'invalid', { reason: 'authorization_pending' }) : polls === 2 ? fail(400, 'invalid', { reason: 'slow_down' }) : { key: 'hm_sk_device_secret', prefix: 'hm_sk_dev', scopes: ['profiles:read'], workspaceId: 'w1' }),
    });
    await run(['login', '--url', 'https://x.test', '--scopes', 'profiles:read'], h.io);
    expect(h.calls[0]!.body).toEqual({ scopes: ['profiles:read'] });
    expect(h.calls[0]!.headers.authorization).toBeUndefined();
    expect(h.calls[1]!.body).toEqual({ deviceCode: 'dc1' });
    expect(h.slept).toEqual([5000, 5000, 10000]);
    expect(h.opened).toEqual(['https://x.test/device?code=ABCD-EFGH']);
    expect(h.out[0]).toContain('ABCD-EFGH');
    expect(h.out.join('\n')).not.toContain('hm_sk_device_secret');
    expect(await loadConfig(h.io.env)).toEqual({ apiKey: 'hm_sk_device_secret', baseUrl: 'https://x.test' });
  });

  it('login with an atlas sign-in: no browser, the Atlas token is swapped for a key; no atlas = device login', async () => {
    const h = await harness({
      'GET /v1/auth/atlas-cli': () => ({ available: true, audience: 'oac_hm' }),
      'POST /v1/auth/atlas-cli': () => ({ key: 'hm_sk_atlas_secret', prefix: 'hm_sk_atl', scopes: ['profiles:read'], workspaceId: 'w1' }),
    });
    const asked: string[] = [];
    h.io.atlasToken = async (aud) => { asked.push(aud); return 'atlas.jwt.token'; };
    await run(['login', '--url', 'https://x.test', '--scopes', 'profiles:read', '--app', 'formflow', '--workspace', 'w1'], h.io);
    expect(asked).toEqual(['oac_hm']);
    expect(h.calls[1]!.body).toEqual({ token: 'atlas.jwt.token', scopes: ['profiles:read'], app: 'formflow', workspaceId: 'w1' });
    expect(h.opened).toEqual([]);
    expect(h.out.join('\n')).not.toContain('hm_sk_atlas_secret');
    expect(await loadConfig(h.io.env)).toEqual({ apiKey: 'hm_sk_atlas_secret', baseUrl: 'https://x.test' });

    const d = await harness({
      'GET /v1/auth/atlas-cli': () => ({ available: true, audience: 'oac_hm' }),
      'POST /v1/auth/device': () => ({ deviceCode: 'dc1', userCode: 'ABCD-EFGH', verificationUrl: 'https://x.test/device', interval: 1, expiresIn: 60 }),
      'POST /v1/auth/device/token': () => ({ key: 'hm_sk_x', prefix: 'hm_sk_x', scopes: ['profiles:read'], workspaceId: 'w1' }),
    });
    d.io.atlasToken = async () => null; // atlas not installed or not signed in
    await run(['login', '--url', 'https://x.test', '--scopes', 'profiles:read'], d.io);
    expect(d.calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual(['GET /v1/auth/atlas-cli', 'POST /v1/auth/device', 'POST /v1/auth/device/token']);
  });

  it('login --app asks for a key bound to that product', async () => {
    const h = await harness({
      'POST /v1/auth/device': () => ({ deviceCode: 'dc1', userCode: 'ABCD-EFGH', verificationUrl: 'https://x.test/device', interval: 1, expiresIn: 60 }),
      'POST /v1/auth/device/token': () => ({ key: 'hm_sk_x', prefix: 'hm_sk_x', scopes: ['profiles:read'], workspaceId: 'w1' }),
    });
    await run(['login', '--url', 'https://x.test', '--scopes', 'profiles:read', '--app', 'formflow'], h.io);
    expect(h.calls[0]!.body).toEqual({ scopes: ['profiles:read'], app: 'formflow' });
  });

  it('a denied or expired device login stores nothing', async () => {
    for (const reason of ['access_denied', 'expired_token']) {
      const h = await harness({
        'POST /v1/auth/device': () => ({ deviceCode: 'dc', userCode: 'U', verificationUrl: 'https://x.test/d', interval: 1, expiresIn: 60 }),
        'POST /v1/auth/device/token': () => fail(400, 'invalid', { reason }),
      });
      await expect(run(['login'], h.io)).rejects.toThrow(reason === 'access_denied' ? 'denied' : 'expired');
      expect(await loadConfig(h.io.env)).toBeNull();
    }
  });

  it('keeps one login per profile; logout forgets only that one', async () => {
    const h = await harness({ 'GET /v1/workspace': () => ({ name: 'Acme' }) });
    await run(['login', '--key', 'hm_sk_one', '--url', 'https://a.test'], h.io);
    await run(['login', '--key', 'hm_sk_two', '--url', 'https://b.test', '--profile', 'work'], h.io);
    expect((await loadConfig(h.io.env, 'work'))?.apiKey).toBe('hm_sk_two');
    expect((await loadConfig({ ...h.io.env, HERMETICA_PROFILE: 'work' }))?.baseUrl).toBe('https://b.test');
    await run(['logout', '--profile', 'work'], h.io);
    expect(await loadConfig(h.io.env, 'work')).toBeNull();
    expect((await loadConfig(h.io.env))?.apiKey).toBe('hm_sk_one');
  });

  it('whoami and status print the actor and each blocker with its fixing call', async () => {
    const h = await harness({
      'GET /v1/me': () => ({ actor: { type: 'api_key', id: 'k1', workspaceId: 'w1', scopes: ['settings:read'] }, user: null }),
      'GET /v1/readiness': () => ({ canSend: { emailTransactional: false }, checks: [
        { key: 'email_connection', ok: false, blocks: ['email_transactional'], fix: 'Connect a provider', api: { method: 'POST', path: '/v1/connections' }, requiredScope: 'connections:write', callerHasScope: false },
        { key: 'webhook_endpoint', ok: true, blocks: [], fix: '' },
      ] }),
    }, { HERMETICA_API_KEY: 'hm_sk_env' });
    await run(['whoami'], h.io);
    expect(h.out[0]).toBe('api_key k1\nworkspace w1\nscopes settings:read');
    expect(await run(['status'], h.io)).toBe(0);
    expect(h.out.slice(1)).toEqual([
      'emailTransactional: no',
      '- email_connection (blocks email_transactional): Connect a provider',
      '    POST /v1/connections  (needs connections:write: hermetica scopes request connections:write --reason ...)',
    ]);
    expect(await run(['health', '--json'], h.io)).toBe(1); // an error-level check fails health by default
    expect(JSON.parse(h.out.at(-1)!).checks).toEqual([
      { id: 'email_connection', status: 'error', detail: 'blocks email_transactional', remedy: { fix: 'Connect a provider', api: { method: 'POST', path: '/v1/connections' }, requiredScope: 'connections:write', callerHasScope: false } },
      { id: 'webhook_endpoint', status: 'ok', detail: '', remedy: null },
    ]);
    expect(await run(['status', '--fail-on', 'never', '--json'], h.io)).toBe(0);
    await expect(run(['status', '--fail-on', 'sometimes'], h.io)).rejects.toThrow('--fail-on is one of');
  });

  it('plan sends the JSON file as a dry run and lists only changes; apply --prune applies; YAML files are parsed', async () => {
    const changes = [{ kind: 'topic', key: 'email:news', action: 'create' }, { kind: 'list', key: 'Customers', action: 'update', fields: ['description'] }, { kind: 'field', key: 'plan', action: 'noop' }];
    const h = await harness({ 'PUT /v1/config': () => ({ dryRun: true, changes }) }, { HERMETICA_API_KEY: 'hm_sk_env' });
    const file = join(h.dir, 'hermetica.json');
    await writeFile(file, JSON.stringify({ topics: [{ channel: 'email', key: 'news', name: 'News' }] }));
    expect(await run(['plan', '-f', file], h.io)).toBe(2); // drift
    expect(h.calls[0]!.url.search).toBe('?dryRun=true');
    expect(h.out).toEqual(['+ topic email:news', '~ list Customers (description)', 'Plan: 1 to create, 1 to update, 0 to archive, 1 unchanged.']);
    expect(await run(['apply', '-f', file, '--prune'], h.io)).toBe(0);
    expect(h.calls[1]!.url.search).toBe('');
    expect(h.calls[1]!.body).toMatchObject({ prune: true, topics: [{ key: 'news' }] });
    const yml = join(h.dir, 'hermetica.yaml');
    await writeFile(yml, 'topics:\n  - channel: email\n    key: news\n    name: News\n');
    await run(['plan', '-f', yml], h.io);
    expect(h.calls[2]!.body).toEqual({ topics: [{ channel: 'email', key: 'news', name: 'News' }] });
    await writeFile(yml, 'topics: [unclosed');
    await expect(run(['plan', '-f', yml], h.io)).rejects.toThrow('not valid YAML');
  });

  it('send --sandbox mails <outcome>@sandbox.hermeticor.test through send-raw and refuses other addresses', async () => {
    const h = await harness({ 'POST /v1/transactional/send-raw': () => ({ results: [] }) }, { HERMETICA_API_KEY: 'hm_sk_env' });
    await run(['send', '--sandbox', '--outcome', 'bounce'], h.io);
    const body = h.calls[0]!.body as { rawMime: string; to: string[] };
    expect(body.to).toEqual(['bounce@sandbox.hermeticor.test']);
    expect(body.rawMime).toContain('To: bounce@sandbox.hermeticor.test\r\n');
    await expect(run(['send', '--sandbox', '--to', 'ada@example.com'], h.io)).rejects.toThrow('sandbox');
    await expect(run(['send', '--to', 'ada@example.com'], h.io)).rejects.toThrow('sandbox');
    expect(h.calls).toHaveLength(1);
  });

  it('scopes request asks, prints the approve link and waits for the decision', async () => {
    let gets = 0;
    const h = await harness({
      'POST /v1/api-keys/requests': () => ({ id: 'r1', status: 'pending', approveUrl: 'https://x.test/approve/r1' }),
      'GET /v1/api-keys/requests/r1': () => ({ id: 'r1', status: ++gets < 2 ? 'pending' : 'approved' }),
    }, { HERMETICA_API_KEY: 'hm_sk_env' });
    await run(['scopes', 'request', 'connections:write', 'settings:write', '--reason', 'connect SES'], h.io);
    expect(h.calls[0]!.body).toEqual({ scopes: ['connections:write', 'settings:write'], reason: 'connect SES' });
    expect(h.out).toEqual(['Ask a workspace owner to approve: https://x.test/approve/r1', 'Request approved.']);
    await expect(run(['scopes', 'request', 'x:read'], h.io)).rejects.toThrow('--reason');
  });
});
