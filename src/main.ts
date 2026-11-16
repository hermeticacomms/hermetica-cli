#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { ApiError } from './client.ts';
import { askKey, run } from './commands.ts';

/** Best effort: with no desktop opener the printed URL is enough. */
const openUrl = (url: string): void => {
  const [cmd, ...args] = process.platform === 'darwin' ? ['open', url] : process.platform === 'win32' ? ['cmd', '/c', 'start', '', url] : ['xdg-open', url];
  try { spawn(cmd!, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* no opener */ }
};

/** `atlas token --audience <id> --json` when the Atlas CLI is installed and signed in; anything else = null (device login instead). */
const atlasToken = (audience: string): Promise<string | null> => new Promise((done) => {
  execFile('atlas', ['token', '--audience', audience, '--json'], { timeout: 20_000, shell: process.platform === 'win32' }, (err, stdout) => {
    if (err) return done(null);
    try { done((JSON.parse(stdout) as { access_token?: string }).access_token ?? null); } catch { done(null); }
  });
});

try {
  await run(process.argv.slice(2), { env: process.env, fetch, out: (s) => process.stdout.write(`${s}\n`), sleep: (ms) => sleep(ms), askKey, openUrl, atlasToken });
} catch (e) {
  const msg = e instanceof ApiError ? `${e.status} ${e.code}: ${e.message}${e.details ? `\n${JSON.stringify(e.details, null, 2)}` : ''}` : e instanceof Error ? e.message : String(e);
  process.stderr.write(`${msg}\n`);
  process.exitCode = 1;
}
