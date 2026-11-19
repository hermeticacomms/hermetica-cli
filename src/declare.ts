import { chmod, readFile, writeFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import type { Client } from './client.ts';
import type { Io } from './commands.ts';

type Change = { kind: string; key: string; action: 'create' | 'update' | 'noop' | 'archive' | 'pause'; fields?: string[] };
const SIGN = { create: '+', update: '~', archive: '-', pause: '-', noop: '=' } as const;

/** `{ "env": "VAR" }` anywhere in the file is replaced by that environment variable, so keys (a webhook preset's ingest key) stay out of the file and the API sees only the value. */
export function resolveEnv(v: unknown, env: NodeJS.ProcessEnv, path = '$'): unknown {
  if (Array.isArray(v)) return v.map((x, i) => resolveEnv(x, env, `${path}[${i}]`));
  if (!v || typeof v !== 'object') return v;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length === 1 && keys[0] === 'env' && typeof o['env'] === 'string') {
    const value = env[o['env']];
    if (value === undefined || value === '') throw new Error(`${path}: environment variable ${o['env']} is not set`);
    return value;
  }
  return Object.fromEntries(keys.map((k) => [k, resolveEnv(o[k], env, `${path}.${k}`)]));
}

/** `.yml`/`.yaml` files are YAML, anything else JSON (the same document shape). */
async function readConfigFile(path: string | undefined): Promise<Record<string, unknown>> {
  if (!path) throw new Error('Give the config file: -f hermetica.yaml (or .json)');
  const yaml = /\.ya?ml$/i.test(path);
  const text = await readFile(path, 'utf8').catch((e: unknown) => { throw new Error(`Cannot read ${path}`, { cause: e }); });
  let doc: unknown;
  try { doc = yaml ? parseYaml(text) : JSON.parse(text); } catch (e) { throw new Error(`${path} is not valid ${yaml ? 'YAML' : 'JSON'}`, { cause: e }); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error(`${path} must hold one object (topics, fields, lists, ...)`);
  return doc as Record<string, unknown>;
}

/** `plan` (dry run) or `apply` the declarative config; only differences are listed, with a count line. Returns the exit code: plan is 2 when anything would change. */
export async function planOrApply(io: Io, client: Client, apply: boolean, f: { file?: string | undefined; prune?: boolean | undefined; 'secret-out'?: string | undefined }): Promise<number> {
  const doc = resolveEnv(await readConfigFile(f.file), io.env) as Record<string, unknown>;
  const r = (await client.request('PUT', '/v1/config', { query: apply ? {} : { dryRun: 'true' }, body: f.prune ? { ...doc, prune: true } : doc })) as { changes: (Change & { secret?: string })[] };
  await saveSecrets(io, r.changes, f['secret-out']);
  for (const c of r.changes) if (c.action !== 'noop') io.out(`${SIGN[c.action]} ${c.kind} ${c.key}${c.fields?.length ? ` (${c.fields.join(', ')})` : ''}`);
  const n = (a: Change['action']) => r.changes.filter((c) => c.action === a).length;
  io.out(`${apply ? 'Applied' : 'Plan'}: ${n('create')} to create, ${n('update')} to update, ${n('archive')} to archive, ${n('pause') ? `${n('pause')} to pause, ` : ''}${n('noop')} unchanged.`);
  return !apply && r.changes.some((c) => c.action !== 'noop') ? 2 : 0;
}

/** HM-I4: signing secrets of endpoints this apply created are shown once: to a 0600 env file with --secret-out, else printed once. */
async function saveSecrets(io: Io, changes: { key: string; secret?: string }[], file?: string): Promise<void> {
  const made = changes.filter((c) => c.secret);
  if (!made.length) return;
  if (!file) {
    for (const c of made) io.out(`secret for ${c.key}: ${c.secret} (shown once; next time pass --secret-out <file> to save it instead)`);
    return;
  }
  const lines = made.map((c, i) => `# webhook endpoint ${c.key}\nHERMETICA_WEBHOOK_SECRET${i ? `_${i + 1}` : ''}=${c.secret}`);
  await writeFile(file, `${lines.join('\n')}\n`, { mode: 0o600, flag: 'a' });
  await chmod(file, 0o600);
  io.out(`Saved ${made.length} signing secret${made.length > 1 ? 's' : ''} to ${file} (mode 0600).`);
}

export const SANDBOX_DOMAIN = 'sandbox.hermeticor.test';
const OUTCOMES = ['delivered', 'bounce', 'soft-bounce', 'complaint'];
export interface SendFlags { sandbox?: boolean | undefined; outcome?: string | undefined; to?: string | undefined; from?: string | undefined; subject?: string | undefined; text?: string | undefined }

/** A raw test email to a sandbox address: no provider needed, and the outcome (delivered, bounce, ...) is chosen by the address. */
export async function sendSandbox(io: Io, client: Client, f: SendFlags): Promise<void> {
  if (!f.sandbox) throw new Error('Only sandbox sends for now: hermetica send --sandbox [--outcome bounce] (use "openapi" for real sends)');
  if (f.outcome && !OUTCOMES.includes(f.outcome)) throw new Error(`--outcome is one of ${OUTCOMES.join(', ')}`);
  const to = f.to ?? `${f.outcome ?? 'delivered'}@${SANDBOX_DOMAIN}`;
  if (!to.toLowerCase().endsWith(`@${SANDBOX_DOMAIN}`)) throw new Error(`--sandbox sends only to <outcome>@${SANDBOX_DOMAIN}`);
  const rawMime = [
    `From: ${f.from ?? `cli@${SANDBOX_DOMAIN}`}`, `To: ${to}`, `Subject: ${f.subject ?? 'Hermetica CLI sandbox test'}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '',
    f.text ?? 'Sent with hermetica send --sandbox.',
  ].join('\r\n');
  io.out(JSON.stringify(await client.request('POST', '/v1/transactional/send-raw', { body: { rawMime, to: [to] } }), null, 2));
}
