/**
 * Orchestrates the auto-memory → opensquid sync (G.6 + MAU.1).
 *
 * Reads every `*.md` (minus `MEMORY.md`, the index) in a source directory,
 * parses each via the reader, and reconciles it against the engine store:
 *   - name not present              → `engine.memoryCreate`  (imported)
 *   - name present, content changed → `engine.memoryUpdate`  (refreshed)
 *   - name present, content same    → no-op                  (skipped)
 *
 * Identity: the auto-memory file's frontmatter `name` field. Engine
 * `MemoryListRow` has no `name` column, so the slug round-trips through
 * `origin.host` via the `IMPORT_HOST_PREFIX` marker. `fetchExistingImportIndex`
 * pages `memory.list` once and returns a `name → { id }` map; the caller passes
 * it in via `opts.existingIndex` so iteration is purely local.
 *
 * Refresh detection (MAU.1): `MemoryListRow` carries no `content`, and
 * `memoryUpdate` cannot write `origin` — so a content hash stashed in
 * `origin.host` would go stale after an update and re-trigger forever. Instead,
 * for an existing entry we `memoryGet({ id })` (returns the FULL body) and
 * compare against the file body; equal → skip, differ → update. After an update
 * the stored content matches the file, so the next run no-ops (self-terminating).
 * `dryRun` performs NO engine reads or writes — it reports existing entries as
 * `skipped` (a coarse preview; refresh detection needs a live read).
 *
 * Scope mapping (Phase-2 lock): feedback / user / reference → user-scope;
 * project → project-scope. All imports tagged `authored_by: 'user'`
 * (auto-memory is by definition user-authored → eviction-immune).
 *
 * `fileWhitelist` is the G.7 hook hand-off: when set, only basenames in the
 * list are candidates. Undefined → all `.md` files except `MEMORY.md`.
 *
 * Imports from: node:fs, node:path, ../../engine/client.js, ./auto_memory_reader.js.
 * Imported by: setup/cli/memory.ts, auto_memory_snapshot.ts, auto_memory_importer.test.ts.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import type { EngineClient } from '../../engine/client.js';

import { readAutoMemory } from './auto_memory_reader.js';

const TYPE_TO_SCOPE: Record<string, 'user' | { project: string }> = {
  user: 'user',
  feedback: 'user',
  reference: 'user',
  project: { project: '' },
};

/** Marker that lets us re-derive the auto-memory `name` slug from the engine row. */
export const IMPORT_HOST_PREFIX = 'opensquid-import:auto-memory:';

/** An engine memory previously imported from auto-memory, keyed by name slug. */
export interface ImportIndexEntry {
  id: string;
}

export interface ImportResult {
  imported: number;
  refreshed: number;
  skipped: number;
  errors: { path: string; reason: string }[];
}

export interface ImportOpts {
  dryRun: boolean;
  /** Pre-fetched `name → { id }` map of auto-memory entries already in the engine. */
  existingIndex: Map<string, ImportIndexEntry>;
  /** G.7 snapshot hook hand-off; undefined → all .md files except MEMORY.md. */
  fileWhitelist?: string[];
}

export async function importAutoMemoryDir(
  dir: string,
  engine: EngineClient,
  opts: ImportOpts,
): Promise<ImportResult> {
  const allFiles = (await fs.readdir(dir)).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
  const files = opts.fileWhitelist
    ? allFiles.filter((f) => opts.fileWhitelist!.includes(f))
    : allFiles;
  const result: ImportResult = { imported: 0, refreshed: 0, skipped: 0, errors: [] };
  for (const file of files) {
    const path = join(dir, file);
    try {
      const parsed = await readAutoMemory(path);
      const name = parsed.frontmatter.name;
      const scope = TYPE_TO_SCOPE[parsed.frontmatter.metadata.type] ?? 'user';
      const existing = opts.existingIndex.get(name);

      if (existing === undefined) {
        if (!opts.dryRun) {
          const created = await engine.memoryCreate({
            description: parsed.frontmatter.description,
            content: parsed.body,
            authored_by: 'user',
            scope,
            origin: { host: `${IMPORT_HOST_PREFIX}${name}` },
          });
          // Track in-map so the same name twice in one run reconciles, not re-creates.
          opts.existingIndex.set(name, { id: created.id });
        }
        result.imported += 1;
        continue;
      }

      // Existing entry. dryRun is read-free → report as skipped (coarse preview).
      if (opts.dryRun) {
        result.skipped += 1;
        continue;
      }
      const current = await engine.memoryGet({ id: existing.id });
      if (current.content !== parsed.body) {
        await engine.memoryUpdate({
          id: existing.id,
          description: parsed.frontmatter.description,
          content: parsed.body,
          scope,
        });
        result.refreshed += 1;
      } else {
        result.skipped += 1;
      }
    } catch (e) {
      result.errors.push({ path, reason: (e as Error).message });
    }
  }
  return result;
}

/**
 * Pages `engine.memoryList` and returns a `name → { id }` map of auto-memory
 * entries already in the engine (extracted from `origin.host` via
 * `IMPORT_HOST_PREFIX`). Non-import rows (no marker) are ignored.
 *
 * The caller passes the map to `importAutoMemoryDir` (so iteration is local)
 * and to `pruneOrphanedImports` (MAU.2). The `{ id }` lets the importer
 * `memoryGet` / `memoryUpdate` the right row on refresh.
 */
export async function fetchExistingImportIndex(
  engine: EngineClient,
  pageSize = 200,
): Promise<Map<string, ImportIndexEntry>> {
  const index = new Map<string, ImportIndexEntry>();
  let offset = 0;
  // Cap iterations so a bug in the engine list doesn't infinite-loop here.
  for (let i = 0; i < 1000; i++) {
    const page = await engine.memoryList({ limit: pageSize, offset });
    for (const row of page.results) {
      const host = row.origin?.host;
      if (host?.startsWith(IMPORT_HOST_PREFIX)) {
        index.set(host.slice(IMPORT_HOST_PREFIX.length), { id: row.id });
      }
    }
    if (page.returned < pageSize) break;
    offset += page.returned;
  }
  return index;
}
