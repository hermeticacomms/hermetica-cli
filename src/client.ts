import { randomUUID } from 'node:crypto';
import type { CliConfig } from './config.ts';

export type Query = Record<string, string | number | boolean | undefined>;
export interface Client { request: (method: string, path: string, o?: { query?: Query; body?: unknown }) => Promise<unknown> }

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) { super(message); this.status = status; this.code = code; this.details = details; }
}

/** Bearer-key client over the REST API (no key: anonymous, for the device login). Writes carry a fresh Idempotency-Key, so a retried command never repeats the action server-side. */
export function makeClient(cfg: CliConfig, fetchFn: typeof fetch = fetch): Client {
  return {
    async request(method, path, o = {}) {
      const url = new URL(`${cfg.baseUrl}${path}`); // keeps a base path such as https://host/api
      for (const [k, v] of Object.entries(o.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
      const write = method !== 'GET' && method !== 'HEAD';
      const res = await fetchFn(url, {
        method,
        headers: { ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}), accept: 'application/json', ...(o.body === undefined ? {} : { 'content-type': 'application/json' }), ...(write ? { 'idempotency-key': randomUUID() } : {}) },
        ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }),
      });
      const text = await res.text();
      let data: unknown = text;
      try { data = text ? JSON.parse(text) : null; } catch { /* plain text body */ }
      if (!res.ok) {
        const e = (data as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
        throw new ApiError(res.status, e?.code ?? 'http_error', e?.message ?? `${res.status} ${res.statusText}`, e?.details);
      }
      return data;
    },
  };
}
