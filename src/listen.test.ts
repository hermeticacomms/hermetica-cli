import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { run, type Io } from './commands.ts';
import { signBody } from './listen.ts';

type Call = { method: string; url: string; headers: Record<string, string>; body: string | undefined };

const sse = (...chunks: string[]) => new Response(new ReadableStream({ start(c) { for (const s of chunks) c.enqueue(new TextEncoder().encode(s)); c.close(); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });

describe('webhooks listen', () => {
  it('signs exactly like a real delivery (t=<unix>,v1=<hmac of "t.body">)', () => {
    expect(signBody('whsec_test', '{"a":1}', 1700000000)).toBe('t=1700000000,v1=38877139021993b830af32feea6e18a8da83eb2f6e49ee50bd9e4cf4ca4d3789');
  });

  it('opens a session, forwards each streamed event byte for byte with delivery headers, and deletes the session when it ends', async () => {
    const body = JSON.stringify({ id: '0190aaaa-0000-7000-8000-000000000001', topic: 'profile.updated', workspaceId: 'w1', createdAt: '2026-11-13T10:00:00.000Z', data: { id: 'p1' } });
    const calls: Call[] = [];
    let streams = 0;
    const fakeFetch = (async (input: string | URL, init: RequestInit = {}) => {
      const c: Call = { method: init.method ?? 'GET', url: String(input), headers: init.headers as Record<string, string>, body: init.body as string | undefined };
      calls.push(c);
      const path = new URL(c.url).pathname;
      if (c.method === 'POST' && path === '/v1/webhooks/listen') return new Response(JSON.stringify({ id: 's1', topics: ['profile.*'], secret: 'whsec_session', expiresAt: '2026-11-13T11:00:00.000Z' }), { status: 201 });
      if (path === '/v1/webhooks/listen/s1/events') return ++streams === 1 ? sse(': keep-alive\n\nid: 7\nevent: webhook\nda', `ta: ${body}\n\n`) : new Response('{}', { status: 404 });
      if (path === '/hook') return new Response(null, { status: 204 });
      if (c.method === 'DELETE') return new Response('{"ok":true}', { status: 200 });
      return new Response('{}', { status: 500 });
    }) as unknown as typeof fetch;
    const out: string[] = [];
    const io: Io = { env: { HERMETICA_API_KEY: 'hm_sk_env', HERMETICA_API_URL: 'https://api.test' }, fetch: fakeFetch, out: (s) => out.push(s), sleep: async () => {}, askKey: async () => '' };

    await run(['webhooks', 'listen', '--forward-to', 'http://localhost:3000/hook', '--topics', 'profile.*'], io);

    expect(JSON.parse(calls[0]!.body!)).toEqual({ topics: ['profile.*'] });
    expect(calls[1]!.headers.authorization).toBe('Bearer hm_sk_env');
    const fwd = calls.find((c) => c.url === 'http://localhost:3000/hook')!;
    expect(fwd.body).toBe(body);
    expect(fwd.headers).toMatchObject({ 'content-type': 'application/json', 'user-agent': 'Hermetica-Webhooks/1', 'hermetica-event-id': '0190aaaa-0000-7000-8000-000000000001', 'hermetica-topic': 'profile.updated' });
    const [, t, v1] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(fwd.headers['hermetica-signature']!)!;
    expect(v1).toBe(createHmac('sha256', 'whsec_session').update(`${t}.${body}`).digest('hex'));
    expect(out.some((l) => l.includes('whsec_session'))).toBe(true); // shown once so the receiver can be configured
    expect(out.some((l) => l.includes('profile.updated') && l.includes('-> 204'))).toBe(true);
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', url: 'https://api.test/v1/webhooks/listen/s1' });
  });

  it('needs --forward-to as an http(s) URL', async () => {
    const io: Io = { env: { HERMETICA_API_KEY: 'hm_sk_env' }, fetch: (async () => new Response('{}')) as unknown as typeof fetch, out: () => {}, sleep: async () => {}, askKey: async () => '' };
    await expect(run(['webhooks', 'listen'], io)).rejects.toThrow('--forward-to');
    await expect(run(['webhooks', 'listen', '--forward-to', 'localhost:3000'], io)).rejects.toThrow('http(s) URL');
  });
});
