import { readFile } from 'node:fs/promises';

/** `key=value` words into a record; any other word is an error, so a typo never becomes a silent positional. */
export function pairs(words: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const w of words) {
    const i = w.indexOf('=');
    if (i < 1) throw new Error(`Expected key=value, got "${w}"`);
    out[w.slice(0, i)] = w.slice(i + 1);
  }
  return out;
}

const readStdin = async (): Promise<string> => { let s = ''; for await (const c of process.stdin) s += String(c); return s; };

/** `--data` as inline JSON, `@file.json`, or `-` for stdin. */
export async function readData(raw: string | undefined): Promise<unknown> {
  if (raw === undefined) return undefined;
  const text = raw === '-' ? await readStdin() : raw.startsWith('@') ? await readFile(raw.slice(1), 'utf8') : raw;
  try { return JSON.parse(text); } catch { throw new Error('--data is not valid JSON'); }
}
