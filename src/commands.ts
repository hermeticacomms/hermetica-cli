import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { pairs, readData } from './args.ts';
import { type Client, makeClient } from './client.ts';
import { loadConfig } from './config.ts';
import { login, logout, requestScopes, status, whoami } from './account.ts';
import { planOrApply, sendSandbox } from './declare.ts';
import { buildCall, fetchSpec, findOperation, operations } from './openapi.ts';
import { listen } from './listen.ts';

export const RESOURCES: Record<string, string> = {
  profiles: '/v1/profiles', lists: '/v1/lists', campaigns: '/v1/campaigns', sequences: '/v1/outbound/sequences', templates: '/v1/templates',
};
/** list/get only: creating these goes through flows (connect a mailbox, a lead search, a received reply) the CLI does not model. */
export const READ_ONLY: Record<string, string> = { mailboxes: '/v1/outbound/mailboxes', leads: '/v1/leads', inbox: '/v1/outbound/inbox' };
const LISTABLE: Record<string, string> = { ...RESOURCES, ...READ_ONLY };

export const HELP = `hermetica <command>

  login [--scopes a:read,b:write] [--url https://...]     sign in through the browser (device code); the key is stored, never shown
  login --key hm_sk_... | --paste                           store an existing secret key instead
  logout                                                    forget the stored key of this profile
  whoami                                                    who the stored key acts as, and its scopes
  status                                                    what blocks sending, with the API call that fixes each step
  plan -f hermetica.yaml [--prune]                          show what apply would change (config as code, YAML or JSON)
  apply -f hermetica.yaml [--prune]                         create/update to match the file; --prune archives what it leaves out
  send --sandbox [--outcome bounce|soft-bounce|complaint]   test email to <outcome>@sandbox.hermeticor.test, no provider needed
  scopes request <scope> [...] --reason "..."               ask an owner for more scopes and wait for the answer
  <resource> list [key=value ...]                            resources: ${Object.keys(RESOURCES).join(', ')}
  <resource> get <id>
  <resource> create --data '<json>' | @file.json | -
  ${Object.keys(READ_ONLY).join(', ')} list [key=value ...] | get <id>
  enrollments list <sequenceId> [key=value ...]              prospects enrolled in a sequence or workflow
  enrollments get <sequenceId> <enrollmentId>                the step trail of one enrollment
  send-test campaign <id> --to a@x.com[,b@y.com]             or --data '<json>' (templates need seedListId and connectionId)
  send-test template <id> --data '<json>'
  events tail [name=<event>] [--interval 5]                  print new events as JSON lines until Ctrl-C
  webhooks listen --forward-to <url> [--topics a,b]          forward live webhook events to a local receiver, signed like real deliveries
  export <resource> [key=value ...]                          every page as JSON lines
  openapi list [search]                                      operations of the server's OpenAPI document
  openapi <operationId> [key=value ...] [--data ...]          call any operation: path {params} first, the rest as query

  --profile <name> (or HERMETICA_PROFILE) picks a stored login; HERMETICA_API_KEY and HERMETICA_API_URL override it.`;

export interface Io { env: NodeJS.ProcessEnv; fetch: typeof fetch; out: (s: string) => void; sleep: (ms: number) => Promise<void>; askKey: () => Promise<string>; openUrl?: (url: string) => void }

const json = (x: unknown) => JSON.stringify(x, null, 2);
type Page = { items?: unknown[]; nextCursor?: string | null };

async function* pages(client: Client, path: string, query: Record<string, string>): AsyncGenerator<unknown[]> {
  let cursor: string | undefined;
  do {
    const p = (await client.request('GET', path, { query: { limit: 200, ...query, ...(cursor ? { cursor } : {}) } })) as Page;
    yield p.items ?? [];
    cursor = p.nextCursor ?? undefined;
  } while (cursor);
}

/** Newest-first event pages until a seen id: UUIDv7 ids sort by arrival, so everything above `lastId` is new. Returned oldest first. */
export async function newEvents(client: Client, lastId: string | null, query: Record<string, string>): Promise<{ id: string }[]> {
  const fresh: { id: string }[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 10; i++) {
    const p = (await client.request('GET', '/v1/events', { query: { limit: 100, ...query, ...(cursor ? { cursor } : {}) } })) as { items: { id: string }[]; nextCursor: string | null };
    const mine = lastId ? p.items.filter((e) => e.id > lastId) : p.items;
    fresh.push(...mine);
    // The first poll only shows the latest page, like tail.
    if (!lastId || mine.length < p.items.length || !p.nextCursor) break;
    cursor = p.nextCursor;
  }
  return fresh.toReversed();
}

/** Runs one command line. Throws on bad input or an API error; main.ts prints it and sets the exit code. */
export async function run(argv: string[], io: Io): Promise<void> {
  const { values: f, positionals: [cmd, ...rest] } = parseArgs({
    args: argv, allowPositionals: true,
    options: {
      key: { type: 'string' }, url: { type: 'string' }, data: { type: 'string', short: 'd' }, to: { type: 'string' }, interval: { type: 'string' }, help: { type: 'boolean', short: 'h' },
      profile: { type: 'string' }, scopes: { type: 'string' }, paste: { type: 'boolean' }, file: { type: 'string', short: 'f' }, prune: { type: 'boolean' },
      sandbox: { type: 'boolean' }, outcome: { type: 'string' }, from: { type: 'string' }, subject: { type: 'string' }, text: { type: 'string' }, reason: { type: 'string' },
      'forward-to': { type: 'string' }, topics: { type: 'string' },
    },
  });
  if (!cmd || f.help || cmd === 'help') return io.out(HELP);
  if (cmd === 'login') return login(io, f);
  if (cmd === 'logout') return logout(io, f.profile);

  const cfg = await loadConfig(io.env, f.profile || undefined);
  if (!cfg) throw new Error('Not logged in. Run "hermetica login" or set HERMETICA_API_KEY.');
  const client = makeClient(cfg, io.fetch);
  const [a, b, ...more] = rest;

  if (cmd === 'whoami') return whoami(io, client);
  if (cmd === 'status') return status(io, client);
  if (cmd === 'plan' || cmd === 'apply') return planOrApply(io, client, cmd === 'apply', f);
  if (cmd === 'send') return sendSandbox(io, client, f);
  if (cmd === 'scopes' && a === 'request') return requestScopes(io, client, [b, ...more].filter((x): x is string => !!x), f.reason, Math.max(1, Number(f.interval ?? 5)));

  if (cmd in LISTABLE) {
    const base = LISTABLE[cmd]!;
    if (a === 'list') return io.out(json(await client.request('GET', base, { query: pairs([b, ...more].filter((x): x is string => !!x)) })));
    if (a === 'get' && b) return io.out(json(await client.request('GET', `${base}/${encodeURIComponent(b)}`)));
    if (a === 'create' && cmd in RESOURCES) return io.out(json(await client.request('POST', base, { body: (await readData(f.data)) ?? {} })));
    throw new Error(`Usage: hermetica ${cmd} list | get <id>${cmd in RESOURCES ? ' | create --data ...' : ''}`);
  }
  if (cmd === 'enrollments') {
    // A sequence is a workflow in sequence mode, so its enrollments live under /v1/workflows/:id.
    const [id, enrollmentId] = [b, more[0]];
    const base = id && `/v1/workflows/${encodeURIComponent(id)}/enrollments`;
    if (a === 'list' && base) return io.out(json(await client.request('GET', base, { query: pairs(more.filter((x): x is string => !!x)) })));
    if (a === 'get' && base && enrollmentId) return io.out(json(await client.request('GET', `${base}/${encodeURIComponent(enrollmentId)}/steps`)));
    throw new Error('Usage: hermetica enrollments list <sequenceId> [key=value ...] | get <sequenceId> <enrollmentId>');
  }
  if (cmd === 'send-test') {
    if ((a !== 'campaign' && a !== 'template') || !b) throw new Error('Usage: hermetica send-test campaign|template <id> --to ... | --data ...');
    const body = (await readData(f.data)) ?? (f.to ? { emails: f.to.split(',').map((s) => s.trim()).filter(Boolean) } : undefined);
    if (!body) throw new Error('Give --to or --data');
    return io.out(json(await client.request('POST', `${RESOURCES[`${a}s`]}/${encodeURIComponent(b)}/test-send`, { body })));
  }
  if (cmd === 'events' && a === 'tail') {
    const query = pairs([b, ...more].filter((x): x is string => !!x));
    const every = Math.max(1, Number(f.interval ?? 5)) * 1000;
    let last: string | null = null;
    for (;;) {
      for (const e of await newEvents(client, last, query)) { io.out(JSON.stringify(e)); if (!last || e.id > last) last = e.id; }
      await io.sleep(every);
    }
  }
  if (cmd === 'webhooks' && a === 'listen') {
    if (!f['forward-to']) throw new Error('Usage: hermetica webhooks listen --forward-to http://localhost:3000/webhooks [--topics profile.*,message.event]');
    const stop = new AbortController();
    const onInt = () => stop.abort(); // first Ctrl-C stops cleanly (the session is deleted); a second one exits at once
    process.once('SIGINT', onInt);
    try { return await listen(io, client, cfg, { forwardTo: f['forward-to'], topics: f.topics?.split(',').map((t) => t.trim()).filter(Boolean), signal: stop.signal }); } finally { process.off('SIGINT', onInt); }
  }
  if (cmd === 'export' && a && a in LISTABLE) {
    for await (const items of pages(client, LISTABLE[a]!, pairs([b, ...more].filter((x): x is string => !!x)))) for (const x of items) io.out(JSON.stringify(x));
    return;
  }
  if (cmd === 'openapi' && a) {
    const spec = await fetchSpec(client);
    if (a === 'list') {
      const needle = (b ?? '').toLowerCase();
      for (const o of operations(spec)) if (!needle || `${o.id} ${o.path} ${o.summary}`.toLowerCase().includes(needle)) io.out(`${o.id}\t${o.method} ${o.path}${o.summary ? `\t${o.summary}` : ''}`);
      return;
    }
    const call = buildCall(findOperation(spec, a), pairs([b, ...more].filter((x): x is string => !!x)));
    const body = await readData(f.data);
    return io.out(json(await client.request(call.method, call.path, { query: call.query, ...(body === undefined ? {} : { body }) })));
  }
  throw new Error(`Unknown command "${[cmd, a].filter(Boolean).join(' ')}".\n\n${HELP}`);
}

/** Reads the key from the terminal so it never lands in shell history; the typed characters are not echoed. */
export async function askKey(): Promise<string> {
  let muted = false;
  const output = new Writable({ write(chunk, _enc, done) { if (!muted) process.stderr.write(chunk); done(); } });
  const rl = createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY) });
  try {
    const answer = rl.question('API key (hm_sk_...): '); // the prompt is written before this returns
    muted = true;
    return await answer;
  } finally { rl.close(); process.stderr.write('\n'); }
}
