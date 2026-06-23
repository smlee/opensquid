/**
 * GAC.2 — the managed-block TEXT writer (the harness-agnostic `block`-kind write primitive).
 *
 * Injects/refreshes an opensquid-owned delimited block in an arbitrary TEXT file, preserving all foreign content,
 * with a `.bak` snapshot. Mirrors the CONTRACT of `settings-writer.ts:126-204` (`projectOpensquidHooks`) — replace
 * opensquid-owned region + preserve foreign + `.bak` — but for markdown/plain TEXT, not a parsed JSON tree (the
 * data models differ; see the spec's Alternatives §4). Works on any text file (incl. `.goosehints`) because it is
 * text-opaque: the markers are inert comment lines.
 *
 * Imported by: src/setup/wizard/install_agents_context.ts (GAC.4).
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const BLOCK_BEGIN = '<!-- opensquid:begin (managed - do not edit) -->';
export const BLOCK_END = '<!-- opensquid:end -->';

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * PURE: return `existing` with the FIRST opensquid block replaced in place, else the block appended. Non-greedy
 * (`[\s\S]*?`) so a stray BEGIN/END elsewhere isn't merged; a BEGIN with no matching END does not match → a fresh
 * block is appended (the malformed-marker case never corrupts foreign text).
 */
export function projectManagedBlock(existing: string, body: string): string {
  const block = `${BLOCK_BEGIN}\n${body.trim()}\n${BLOCK_END}`;
  const re = new RegExp(`${escapeRe(BLOCK_BEGIN)}[\\s\\S]*?${escapeRe(BLOCK_END)}`);
  if (re.test(existing)) return existing.replace(re, block);
  const sep = existing.trim().length > 0 ? `${existing.replace(/\s+$/, '')}\n\n` : '';
  return `${sep}${block}\n`;
}

/**
 * Write the block into `path` (ENOENT → fresh file); snapshot `.bak` of the prior content first. Atomic via
 * tmp+rename. Returns 'created' (no prior file) | 'added' (file existed, no block) | 'updated' (block replaced).
 */
export async function writeManagedBlock(
  path: string,
  body: string,
): Promise<'created' | 'updated' | 'added'> {
  let existing = '';
  let existed = true;
  try {
    existing = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    existed = false;
  }
  if (existed) await writeFile(`${path}.bak`, existing);
  const had = existing.includes(BLOCK_BEGIN);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, projectManagedBlock(existing, body));
  await rename(tmp, path);
  return !existed ? 'created' : had ? 'updated' : 'added';
}
