/**
 * Engine → libSQL memory migration (T-MIGRATE-MEMORIES, retire-Rust step 1). Copies the engine's
 * `~/.opensquid/memories/mem-*.md` into the libSQL store via the per-file source + index rebuild —
 * ADDITIVE (copies, never deletes the engine files) and idempotent (writeRecord overwrites
 * atomically; rebuildLibsqlIndex drops + rebuilds). Reuses slice 1a/1b machinery; no new insert path.
 *
 * Imports from: node:fs/promises, node:path, ./backends/libsql_store.js, ./backends/perfile_source.js,
 *   ./embedders/types.js, ./types.js.
 * Imported by: src/cli.ts (the `migrate-memories` command).
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { rebuildLibsqlIndex } from './backends/libsql_store.js';
import { writeRecord } from './backends/perfile_source.js';
import type { Embedder } from './embedders/types.js';
import type { Lesson } from './types.js';

/**
 * Parse one engine `mem-*.md` into a `Lesson`. Verified frontmatter: id, description, created_at,
 * [updated_at], consumed_by_user_lessons, scope (scalar), origin (NESTED). We carry the semantic
 * payload (description + body) + `scope` (as an FTS-discoverable tag) + createdAt; nested `origin`
 * and other provenance stay in the retained source files (the migration is additive).
 */
export function parseMemoryFile(raw: string, fallbackId: string): Lesson {
  const id = /^id:\s*(.+)$/m.exec(raw)?.[1]?.trim() ?? fallbackId;
  const description = /^description:\s*(.+)$/m.exec(raw)?.[1]?.trim() ?? '';
  const scope = /^scope:\s*(.+)$/m.exec(raw)?.[1]?.trim();
  const createdAt =
    /^created_at:\s*'?([^'\n]+)'?$/m.exec(raw)?.[1]?.trim() ?? new Date(0).toISOString();
  const body = raw.includes('\n---\n') ? raw.split('\n---\n').slice(1).join('\n---\n').trim() : raw;
  return {
    id,
    content: `${description}\n\n${body}`.trim(),
    tags: scope ? [`scope:${scope}`] : [],
    source: 'memory',
    author: 'user',
    createdAt,
  };
}

/**
 * Copy every `mem-*.md` in `memDir` into the libSQL store: write each as a per-file record (the
 * source of truth), then rebuild the derived index. Returns the number migrated.
 */
export async function migrateMemories(opts: {
  memDir: string;
  sourceDir: string;
  dbUrl: string;
  embedder: Embedder;
}): Promise<{ migrated: number }> {
  const files = (await readdir(opts.memDir)).filter(
    (f) => f.startsWith('mem-') && f.endsWith('.md'),
  );
  for (const f of files) {
    const raw = await readFile(join(opts.memDir, f), 'utf8');
    await writeRecord(opts.sourceDir, parseMemoryFile(raw, f.replace(/\.md$/, '')));
  }
  await rebuildLibsqlIndex({
    dbUrl: opts.dbUrl,
    embedder: opts.embedder,
    sourceDir: opts.sourceDir,
  });
  return { migrated: files.length };
}
