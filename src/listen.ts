import { createHmac } from 'node:crypto';
import { ApiError, type Client } from './client.ts';
import type { CliConfig } from './config.ts';
import type { Io } from './commands.ts';

type Session = { id: string; topics: string[]; secret: string; expiresAt: string };

/** `Hermetica-Signature` as real deliveries send it: `t=<unix>,v1=<hex hmac-sha256 of "t.body">`. */
export const signBody = (secret: string, body: string, nowSec: number): string =>
  `t=${nowSec},v1=${createHmac('sha256', secret).update(`${nowSec}.${body}`).digest('hex')}`;

/** POSTs one event body to the local receiver with the headers of a real delivery. Never throws: returns the status or the error text. */
export async function forwardEvent(fetchFn: typeof fetch, url: string, secret: string, body: string, nowSec: number): Promise<{ status: number | null; error?: string }> {
  const e = JSON.parse(body) as { id: string; topic: string };
  try {
    const res = await fetchFn(url, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10_000), body,
      headers: { 'content-type': 'application/json', 'user-agent': 'Hermetica-Webhooks/1', 'hermetica-signature': signBody(secret, body, nowSec), 'hermetica-event-id': e.id, 'hermetica-topic': e.topic },
    });
    await res.body?.cancel();
    return { status: res.status };
  } catch (err) {
    return { status: null, error: (err as Error).message };
  }
}

/** `event:`/`data:` blocks of a server-sent event stream. */
export async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  let buf = '';
  const dec = new TextDecoder();
  for await (const bytes of body as AsyncIterable<Uint8Array>) {
    buf += dec.decode(bytes, { stream: true });
    for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (event && data !== undefined) yield { event, data };
    }
  }
}

/**
 * `webhooks listen`: opens a listen session, streams its events and forwards each to `forwardTo`, signed with the session secret.
 * Reconnects when the server closes the stream; ends when the session is gone (404) or on Ctrl-C (`signal`), deleting the session.
 */
export async function listen(io: Io, client: Client, cfg: CliConfig, o: { forwardTo: string; topics?: string[] | undefined; signal?: AbortSignal | undefined }): Promise<void> {
  if (!/^https?:\/\//.test(o.forwardTo)) throw new Error('--forward-to must be an http(s) URL, e.g. http://localhost:3000/webhooks');
  const s = (await client.request('POST', '/v1/webhooks/listen', { body: o.topics?.length ? { topics: o.topics } : {} })) as Session;
  io.out(`Ready. Forwarding ${s.topics.join(', ')} to ${o.forwardTo}`);
  io.out(`Your webhook signing secret for this session is ${s.secret} (set it in your receiver; Ctrl-C to stop)`);
  try {
    while (!o.signal?.aborted) {
      let res: Response;
      try {
        res = await io.fetch(`${cfg.baseUrl}/v1/webhooks/listen/${s.id}/events`, { headers: { authorization: `Bearer ${cfg.apiKey}`, accept: 'text/event-stream' }, ...(o.signal ? { signal: o.signal } : {}) });
      } catch {
        if (o.signal?.aborted) break;
        await io.sleep(2000); // network blip: try again
        continue;
      }
      if (res.status === 404) { io.out('The listen session ended.'); return; }
      if (!res.ok || !res.body) throw new ApiError(res.status, 'http_error', `Could not open the event stream (${res.status})`);
      try {
        for await (const e of sseEvents(res.body)) {
          if (e.event === 'done') { io.out('The listen session ended.'); return; }
          if (e.event !== 'webhook') continue;
          const r = await forwardEvent(io.fetch, o.forwardTo, s.secret, e.data, Math.floor(Date.now() / 1000));
          const { id, topic } = JSON.parse(e.data) as { id: string; topic: string };
          io.out(`${new Date().toISOString()}  ${topic}  ${id}  -> ${r.status ?? `error: ${r.error}`}`);
        }
      } catch { if (!o.signal?.aborted) await io.sleep(1000); } // stream cut mid-way: reconnect, the cursor is kept server-side
    }
  } finally {
    await client.request('DELETE', `/v1/webhooks/listen/${s.id}`).catch(() => {}); // already gone is fine
  }
}
