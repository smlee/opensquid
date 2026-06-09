/**
 * MAU.4 — fail-loud memory drift-detector (read-only diagnosis).
 *
 * Compares the auto-memory source files against the engine's import-marked
 * entries and reports divergence in three categories:
 *   - missing  — a memory on disk that the engine has no import entry for
 *   - stale    — present in both but the engine content differs from disk
 *   - orphaned — an import-marked engine entry whose source .md is gone
 *
 * This is the clause that makes a silent "the sync never ran" impossible to
 * recur: after a session-boundary reconcile (MAU.3) the store should be in
 * sync, so a NON-empty drift is a real bug to surface LOUDLY
 * ([[project_opensquid_runtime_failure_handling]]).
 *
 * READ-ONLY: it never writes/deletes (diagnosis only — mutation is MAU.1/2/3's
 * job). It must NOT swallow engine errors into a falsely-clean report — engine
 * failures propagate (throw) so the caller surfaces them, never reporting
 * `inSync: true` on a failed probe.
 *
 * Stale detection mirrors MAU.1: compare `memoryGet(id).content` against the
 * reader-trimmed file body (NOT a stored hash — `memoryUpdate` can't write a
 * hash, so content-compare is the single source of truth).
 *
 * Imports from: node:fs, node:path, ../../engine/client.js,
 *   ./auto_memory_importer.js, ./auto_memory_reader.js.
 * Imported by: src/setup/cli/doctor.ts (memory section); memory_drift.test.ts.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { fetchExistingImportIndex } from './auto_memory_importer.js';
import { folded, type MemoryStore } from './memory_store_handle.js';
import { readAutoMemory } from './auto_memory_reader.js';

export interface MemoryDrift {
  inSync: boolean;
  /** On disk, no import entry in the engine. */
  missing: string[];
  /** In both, but engine content differs from the disk body. */
  stale: string[];
  /** Import-marked engine entry whose source .md is gone. */
  orphaned: string[];
  total: { disk: number; engineImported: number };
}

export async function computeMemoryDrift(dir: string, store: MemoryStore): Promise<MemoryDrift> {
  // Disk side: name → FOLDED content (`description\n\nbody`). libSQL memory is content-only, so the
  // disk side MUST fold to match the stored content (comparing folded-vs-bare would report every
  // import as stale). A malformed file (reader throws) is skipped — a reader concern, not store drift.
  const diskByName = new Map<string, string>();
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
  for (const f of files) {
    try {
      const parsed = await readAutoMemory(join(dir, f));
      diskByName.set(parsed.frontmatter.name, folded(parsed.frontmatter.description, parsed.body));
    } catch {
      // malformed frontmatter — not comparable; skip (not counted as drift here)
    }
  }

  // Store side: name → { id } for import-marked entries. Errors here PROPAGATE
  // (no catch) so a failed probe never masquerades as inSync.
  const index = await fetchExistingImportIndex(store);

  const missing: string[] = [];
  const stale: string[] = [];
  for (const [name, content] of diskByName) {
    const entry = index.get(name);
    if (entry === undefined) {
      missing.push(name);
      continue;
    }
    const current = await store.get(entry.id);
    if (current?.content !== content) stale.push(name);
  }

  const orphaned: string[] = [];
  for (const name of index.keys()) {
    if (!diskByName.has(name)) orphaned.push(name);
  }

  missing.sort();
  stale.sort();
  orphaned.sort();
  return {
    inSync: missing.length === 0 && stale.length === 0 && orphaned.length === 0,
    missing,
    stale,
    orphaned,
    total: { disk: diskByName.size, engineImported: index.size },
  };
}

/** One-line human summary for `opensquid doctor`. */
export function renderMemoryDrift(d: MemoryDrift): string {
  if (d.inSync) return `memory: in sync (${String(d.total.engineImported)} indexed)`;
  const parts: string[] = [];
  if (d.missing.length > 0) parts.push(`${String(d.missing.length)} missing`);
  if (d.stale.length > 0) parts.push(`${String(d.stale.length)} stale`);
  if (d.orphaned.length > 0) parts.push(`${String(d.orphaned.length)} orphaned`);
  return `memory: DRIFT — ${parts.join(', ')} (disk ${String(d.total.disk)}, indexed ${String(d.total.engineImported)})`;
}
