import { ApiError, type Client, makeClient } from './client.ts';
import { baseUrlOf, clearConfig, profileOf, saveConfig, savedBaseUrl } from './config.ts';
import type { Io } from './commands.ts';

type Device = { deviceCode: string; userCode: string; verificationUrl: string; verificationUrlComplete?: string; interval?: number; expiresIn: number };
type Granted = { key: string; prefix: string; scopes: string[]; workspaceId: string };
/** What the CLI's own commands need (status, sequences/mailboxes/leads/inbox, plan/apply, send); the approver sees and may trim them. */
export const DEFAULT_LOGIN_SCOPES = ['settings:read', 'workflows:read', 'outbound:read', 'leads:read', 'profiles:read', 'profiles:write', 'consent:read', 'consent:write', 'integrations:read', 'integrations:write', 'messages:send'];

export interface LoginFlags { key?: string | undefined; url?: string | undefined; paste?: boolean | undefined; scopes?: string | undefined; profile?: string | undefined }

const reasonOf = (e: unknown): string | undefined =>
  e instanceof ApiError && e.status === 400 ? (e.details as { reason?: string } | undefined)?.reason : undefined;

/** OAuth-style device flow: show the code, open the browser, poll at the server's pace until approved, denied or expired. */
export async function deviceLogin(io: Io, baseUrl: string, scopes?: string[]): Promise<Granted> {
  const anon = makeClient({ apiKey: '', baseUrl }, io.fetch);
  const d = (await anon.request('POST', '/v1/auth/device', { body: { scopes: scopes?.length ? scopes : DEFAULT_LOGIN_SCOPES } })) as Device;
  io.out(`Open ${d.verificationUrl} and enter the code ${d.userCode}`);
  io.openUrl?.(d.verificationUrlComplete ?? d.verificationUrl);
  let every = Math.max(1, d.interval ?? 5) * 1000;
  for (let waited = 0; waited < d.expiresIn * 1000; waited += every) {
    await io.sleep(every);
    try {
      return (await anon.request('POST', '/v1/auth/device/token', { body: { deviceCode: d.deviceCode } })) as Granted;
    } catch (e) {
      const reason = reasonOf(e);
      if (reason === 'authorization_pending') continue;
      if (reason === 'slow_down') { every += 5000; continue; }
      if (reason === 'access_denied') throw new Error('The login was denied in the browser.', { cause: e });
      if (reason === 'expired_token') break;
      throw e;
    }
  }
  throw new Error('The login code expired. Run "hermetica login" again.');
}

/** Device login by default; `--key` / `--paste` store an existing secret key instead. The key itself is never printed. */
export async function login(io: Io, f: LoginFlags): Promise<void> {
  const profile = profileOf(io.env, f.profile);
  const baseUrl = baseUrlOf(io.env, await savedBaseUrl(io.env, profile), f.url);
  if (f.key || f.paste) {
    const apiKey = (f.key ?? (await io.askKey())).trim();
    if (!apiKey.startsWith('hm_sk_')) throw new Error('That is not a secret key (hm_sk_...)');
    const ws = (await makeClient({ apiKey, baseUrl }, io.fetch).request('GET', '/v1/workspace')) as { name?: string; id?: string };
    const file = await saveConfig({ apiKey, baseUrl }, io.env, profile);
    return io.out(`Logged in to ${ws.name ?? ws.id ?? 'the workspace'} at ${baseUrl}. Key stored in ${file} (0600), profile ${profile}.`);
  }
  const g = await deviceLogin(io, baseUrl, f.scopes?.split(',').map((s) => s.trim()).filter(Boolean));
  const file = await saveConfig({ apiKey: g.key, baseUrl }, io.env, profile);
  io.out(`Logged in to workspace ${g.workspaceId} with key ${g.prefix}... (scopes: ${g.scopes.join(', ') || 'none'}). Stored in ${file} (0600), profile ${profile}.`);
}

export async function logout(io: Io, profile?: string): Promise<void> {
  await clearConfig(io.env, profileOf(io.env, profile));
  io.out(`Logged out (profile ${profileOf(io.env, profile)}).`);
}

type Me = { actor: { type: string; id: string; workspaceId: string; role?: string; scopes: string[] }; user: { email?: string } | null };
export async function whoami(io: Io, client: Client): Promise<void> {
  const me = (await client.request('GET', '/v1/me')) as Me;
  io.out(`${me.user?.email ?? `${me.actor.type} ${me.actor.id}`}${me.actor.role ? ` (${me.actor.role})` : ''}\nworkspace ${me.actor.workspaceId}\nscopes ${me.actor.scopes.join(' ') || '(none)'}`);
}

type Readiness = {
  canSend: Record<string, boolean>;
  checks: { key: string; ok: boolean; blocks: string[]; fix: string; api?: { method: string; path: string }; requiredScope?: string; callerHasScope?: boolean }[];
};
export async function status(io: Io, client: Client): Promise<void> {
  const r = (await client.request('GET', '/v1/readiness')) as Readiness;
  io.out(Object.entries(r.canSend).map(([k, v]) => `${k}: ${v ? 'yes' : 'no'}`).join('  '));
  for (const c of r.checks.filter((x) => !x.ok)) {
    io.out(`- ${c.key}${c.blocks.length ? ` (blocks ${c.blocks.join(', ')})` : ''}: ${c.fix}`);
    if (c.api) io.out(`    ${c.api.method} ${c.api.path}${c.requiredScope && c.callerHasScope === false ? `  (needs ${c.requiredScope}: hermetica scopes request ${c.requiredScope} --reason ...)` : ''}`);
  }
  if (r.checks.every((x) => x.ok)) io.out('Nothing blocks sending.');
}

type ScopeRequest = { id: string; status: string; approveUrl?: string };
/** Asks an owner for more scopes on this key, then waits for the decision (Ctrl-C stops waiting; the request stays open). */
export async function requestScopes(io: Io, client: Client, scopes: string[], reason: string | undefined, intervalSec = 5): Promise<void> {
  if (!scopes.length || !reason) throw new Error('Usage: hermetica scopes request <scope> [<scope> ...] --reason "why you need them"');
  let r = (await client.request('POST', '/v1/api-keys/requests', { body: { scopes, reason } })) as ScopeRequest;
  if (r.approveUrl) io.out(`Ask a workspace owner to approve: ${r.approveUrl}`);
  for (let i = 0; r.status === 'pending' && i < 720; i++) {
    await io.sleep(intervalSec * 1000);
    r = (await client.request('GET', `/v1/api-keys/requests/${encodeURIComponent(r.id)}`)) as ScopeRequest;
  }
  io.out(r.status === 'pending' ? `Still pending; check later with: hermetica openapi list api-keys/requests (request ${r.id})` : `Request ${r.status}.`);
}
