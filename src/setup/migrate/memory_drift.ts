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

import type { EngineClient } from '../../engine/client.js';

import { fetchExistingImportIndex } from './auto_memory_importer.js';
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

export async function computeMemoryDrift(dir: string, engine: EngineClient): Promise<MemoryDrift> {
  // Disk side: name → body. A malformed file (reader throws) is skipped — it
  // can't be content-compared, and that's a reader concern, not store drift.
  const diskByName = new Map<string, string>();
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
  for (const f of files) {
    try {
      const parsed = await readAutoMemory(join(dir, f));
      diskByName.set(parsed.frontmatter.name, parsed.body);
    } catch {
      // malformed frontmatter — not comparable; skip (not counted as drift here)
    }
  }

  // Engine side: name → { id } for import-marked entries. Errors here PROPAGATE
  // (no catch) so a failed probe never masquerades as inSync.
  const index = await fetchExistingImportIndex(engine);

  const missing: string[] = [];
  const stale: string[] = [];
  for (const [name, body] of diskByName) {
    const entry = index.get(name);
    if (entry === undefined) {
      missing.push(name);
      continue;
    }
    const current = await engine.memoryGet({ id: entry.id });
    if (current.content !== body) stale.push(name);
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
