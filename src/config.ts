import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface CliConfig { apiKey: string; baseUrl: string }
type Credentials = Record<string, Partial<CliConfig>>;

export const DEFAULT_URL = 'https://hermeticor.com';

/** `$XDG_CONFIG_HOME/hermetica` (default `~/.config/hermetica`). */
export const configDir = (env: NodeJS.ProcessEnv = process.env): string => join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'hermetica');
const file = (env?: NodeJS.ProcessEnv) => join(configDir(env), 'credentials');
/** `--profile`, else HERMETICA_PROFILE, else `default`. */
export const profileOf = (env: NodeJS.ProcessEnv, flag?: string): string => flag || env.HERMETICA_PROFILE || 'default';

async function readAll(env: NodeJS.ProcessEnv): Promise<Credentials> {
  try { return JSON.parse(await readFile(file(env), 'utf8')) as Credentials; } catch { return {}; } // not logged in yet
}

/** One profile's login, overridden by HERMETICA_API_KEY / HERMETICA_API_URL. Null when neither gives a key. */
export async function loadConfig(env: NodeJS.ProcessEnv = process.env, profile = profileOf(env)): Promise<CliConfig | null> {
  const saved = (await readAll(env))[profile] ?? {};
  const apiKey = env.HERMETICA_API_KEY || env.HERMETICA_KEY || saved.apiKey;
  return apiKey ? { apiKey, baseUrl: baseUrlOf(env, saved.baseUrl) } : null;
}

export const baseUrlOf = (env: NodeJS.ProcessEnv, saved?: string, flag?: string): string => (flag || env.HERMETICA_API_URL || env.HERMETICA_URL || saved || DEFAULT_URL).replace(/\/+$/, '');
export const savedBaseUrl = async (env: NodeJS.ProcessEnv, profile: string): Promise<string | undefined> => (await readAll(env))[profile]?.baseUrl;

/** The key is a secret: the directory is 0700 and the file 0600, set again on every write in case it existed with wider modes. */
async function writeAll(all: Credentials, env: NodeJS.ProcessEnv): Promise<string> {
  await mkdir(configDir(env), { recursive: true, mode: 0o700 });
  await chmod(configDir(env), 0o700);
  await writeFile(file(env), `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  await chmod(file(env), 0o600);
  return file(env);
}

export async function saveConfig(cfg: CliConfig, env: NodeJS.ProcessEnv = process.env, profile = profileOf(env)): Promise<string> {
  return writeAll({ ...(await readAll(env)), [profile]: cfg }, env);
}

export async function clearConfig(env: NodeJS.ProcessEnv = process.env, profile = profileOf(env)): Promise<void> {
  const all = await readAll(env);
  if (!(profile in all)) return;
  delete all[profile];
  await writeAll(all, env);
}
