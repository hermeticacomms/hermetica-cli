#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { ApiError } from './client.ts';
import { askKey, run } from './commands.ts';

/** Best effort: with no desktop opener the printed URL is enough. */
const openUrl = (url: string): void => {
  const [cmd, ...args] = process.platform === 'darwin' ? ['open', url] : process.platform === 'win32' ? ['cmd', '/c', 'start', '', url] : ['xdg-open', url];
  try { spawn(cmd!, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* no opener */ }
};

try {
  await run(process.argv.slice(2), { env: process.env, fetch, out: (s) => process.stdout.write(`${s}\n`), sleep: (ms) => sleep(ms), askKey, openUrl });
} catch (e) {
  const msg = e instanceof ApiError ? `${e.status} ${e.code}: ${e.message}${e.details ? `\n${JSON.stringify(e.details, null, 2)}` : ''}` : e instanceof Error ? e.message : String(e);
  process.stderr.write(`${msg}\n`);
  process.exitCode = 1;
}
