/**
 * Orchestrates the auto-memory → opensquid sync (G.6 + MAU.1).
 *
 * Reads every `*.md` (minus `MEMORY.md`, the index) in a source directory,
 * parses each via the reader, and reconciles it against the libSQL MemoryStore
 * (retire-Rust RES-5b — engine-free):
 *   - name not present              → `store.create`  (imported)
 *   - name present, content changed → `store.update`  (refreshed)
 *   - name present, content same    → no-op           (skipped)
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
 * Imports from: node:fs, node:path, ./memory_store_handle.js, ./auto_memory_reader.js.
 * Imported by: setup/cli/memory.ts, auto_memory_snapshot.ts, auto_memory_importer.test.ts.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { folded, type MemoryStore } from './memory_store_handle.js';
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
  store: MemoryStore,
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
      const rawScope = TYPE_TO_SCOPE[parsed.frontmatter.metadata.type] ?? 'user';
      // libSQL scope is a string tag; serialize the MemoryScope (project's value is '' here → 'project').
      const scope = typeof rawScope === 'string' ? rawScope : 'project';
      const existing = opts.existingIndex.get(name);

      if (existing === undefined) {
        if (!opts.dryRun) {
          const created = await store.create({
            name,
            description: parsed.frontmatter.description,
            body: parsed.body,
            scope,
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
      const current = await store.get(existing.id);
      // MF.2 (H3): refresh on a body OR DESCRIPTION change. libSQL memory is content-only — the
      // description folds into content (`description\n\nbody`), so the single folded compare covers
      // BOTH a body and a description edit (re-index either way). A missing row (current===null) is
      // treated as changed → re-create via update path's caller; here defensively refresh.
      const want = folded(parsed.frontmatter.description, parsed.body);
      if (current?.content !== want) {
        await store.update(existing.id, {
          description: parsed.frontmatter.description,
          body: parsed.body,
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
 * Returns a `name → { id }` map of auto-memory entries already in the store, via
 * `store.listImportIndex()` (which pages the libSQL memory rows + extracts the slug from the
 * `origin:import:` marker tag). Non-import rows (no marker) are ignored.
 *
 * The caller passes the map to `importAutoMemoryDir` (so iteration is local) and to
 * `pruneOrphanedImports` (MAU.2). The `{ id }` lets the importer `store.get` / `store.update` the
 * right row on refresh.
 */
export async function fetchExistingImportIndex(
  store: MemoryStore,
): Promise<Map<string, ImportIndexEntry>> {
  // The libSQL store pages internally + maps the `origin:import:<name>` tag → {id} (RES-5a/5b).
  return store.listImportIndex();
}

/**
 * Deletion propagation (MAU.2): remove engine memories whose auto-memory source
 * file no longer exists, so the derived recall index reflects the source.
 *
 * Marker-guarded: only entries in `existingIndex` (i.e. carrying the
 * `IMPORT_HOST_PREFIX` marker) are deletion candidates — engine-native and
 * user-`memorize`d entries are never in that map, so they are structurally
 * unreachable here. `force: true` because import entries are tagged
 * `authored_by: 'user'` (eviction-immune); the marker + an absent source is the
 * authority, and pruning a derived copy does not evict a hand-authored lesson.
 *
 * Safety net for the on-disk set: an entry is kept if its name matches EITHER a
 * file's frontmatter `name` (authoritative; handles name != basename) OR a
 * file's basename. The basename fallback means a transiently-malformed file
 * (which `readAutoMemory` would throw on) still protects its engine copy from
 * being orphaned by a parse error.
 *
 * `dryRun` counts candidates without deleting.
 */
export async function pruneOrphanedImports(
  dir: string,
  store: MemoryStore,
  existingIndex: Map<string, ImportIndexEntry>,
  opts: { dryRun: boolean },
): Promise<{ pruned: number }> {
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
  const onDisk = new Set<string>();
  for (const f of files) {
    onDisk.add(f.replace(/\.md$/, '')); // basename fallback (name usually == basename)
    try {
      const parsed = await readAutoMemory(join(dir, f));
      onDisk.add(parsed.frontmatter.name); // authoritative name (handles name != basename)
    } catch {
      // Malformed file → keep only the basename guard; never let a parse error
      // orphan (delete) its engine copy.
    }
  }
  let pruned = 0;
  for (const [name, entry] of existingIndex) {
    if (!onDisk.has(name)) {
      if (!opts.dryRun) await store.delete(entry.id);
      pruned += 1;
    }
  }
  return { pruned };
}
