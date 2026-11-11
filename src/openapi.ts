import type { Client, Query } from './client.ts';

type Op = { operationId?: string; summary?: string };
export interface Spec { paths?: Record<string, Record<string, Op>> }
export interface Operation { id: string; method: string; path: string; summary: string }

const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

/** Every operation in the server's OpenAPI document, in document order. */
export const operations = (spec: Spec): Operation[] => Object.entries(spec.paths ?? {}).flatMap(([path, ops]) =>
  Object.entries(ops).filter(([m, op]) => METHODS.has(m) && op?.operationId).map(([m, op]) => ({ id: op.operationId!, method: m.toUpperCase(), path, summary: op.summary ?? '' })));

/** `key=value` pairs fill the path's `{key}` placeholders; the rest become the query string. A placeholder left unfilled is an error. */
export function buildCall(op: Operation, pairs: Record<string, string>): { method: string; path: string; query: Query } {
  const query: Query = { ...pairs };
  const path = op.path.replace(/\{([^}]+)\}/g, (_m, name: string) => {
    const v = pairs[name];
    if (v === undefined) throw new Error(`${op.id} needs ${name}=<value>`);
    delete query[name];
    return encodeURIComponent(v);
  });
  return { method: op.method, path, query };
}

export const fetchSpec = async (client: Client): Promise<Spec> => (await client.request('GET', '/openapi.json')) as Spec;

export function findOperation(spec: Spec, id: string): Operation {
  const all = operations(spec);
  const op = all.find((o) => o.id === id) ?? all.find((o) => o.id.toLowerCase() === id.toLowerCase());
  if (!op) throw new Error(`No operation ${id}. Run "hermetica openapi list ${id.slice(0, 12)}" to search.`);
  return op;
}
