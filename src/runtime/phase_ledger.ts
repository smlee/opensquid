/**
 * Durable per-task phase ledger — the TS owner of the filesystem YAML ledger
 * the Rust engine used to write via `task.log_phase` (retire-Rust slice).
 *
 * Layout (UNCHANGED from the engine, so existing on-disk ledgers stay valid):
 *
 *   <OPENSQUID_HOME ?? ~/.opensquid>/phase_ledger/<taskId>/<phase>.yaml
 *
 * ONE FILE PER PHASE; each holds `phase` / `logged_at` (ISO) / optional `note`.
 * Re-logging a phase overwrites its file (idempotent — the engine's per-phase
 * shape, not an append log).
 *
 * Why filesystem YAML and not libSQL: locked design decision (2026-05-17) —
 * the phase ledger is "small, write-mostly, fine as YAML" and explicitly stays
 * filesystem-based, NOT in the libsql DB. This slice moves the WRITER off Rust,
 * it does NOT change the storage medium.
 *
 * This is the DURABLE audit ledger. It is SEPARATE from the gate-readable
 * session-state ledger (`runtime/workflow_phases.ts`), which `handleLogPhase`
 * also writes and which the commit gate reads — that one is untouched here.
 *
 * Imports from: node:fs/promises, node:os, node:path, yaml, ./atomic_write.js.
 * Imported by: src/mcp/tools/log_phase.ts (+ its read-back test).
 */

import { mkdir, readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { parse as yamlParse, stringify as yamlStringify } from 'yaml';

import { atomicWriteFile } from './atomic_write.js';

export interface PhaseLedgerEntry {
  phase: string;
  logged_at: string;
  note?: string;
}

/** The read-back shape — mirrors the engine's `TaskGetLedgerResult` so the
 *  read-back test (and any future reader) ports 1:1. */
export interface PhaseLedger {
  task_id: string;
  phases_logged: string[];
  entries: PhaseLedgerEntry[];
}

/**
 * `<OPENSQUID_HOME ?? ~/.opensquid>/phase_ledger/<taskId>`. OPENSQUID_HOME-aware
 * so tests isolate to a tmp home and the real ledger dir resolves in production
 * (same rooting pattern as `session_state` + `store_lesson`).
 */
export function phaseLedgerDir(taskId: string): string {
  const root = process.env.OPENSQUID_HOME ?? join(homedir(), '.opensquid');
  return join(root, 'phase_ledger', taskId);
}

/**
 * Write `<phase>.yaml` for a task. `mkdir -p` the task dir, then atomic
 * (tmp+rename) write so a crash can't leave a truncated file. The `nowIso`
 * seam keeps `logged_at` deterministic in tests.
 */
export async function writePhaseLedger(
  taskId: string,
  phase: string,
  note?: string,
  nowIso: () => string = () => new Date().toISOString(),
): Promise<void> {
  const dir = phaseLedgerDir(taskId);
  await mkdir(dir, { recursive: true });
  const entry: PhaseLedgerEntry = {
    phase,
    logged_at: nowIso(),
    ...(note !== undefined ? { note } : {}),
  };
  await atomicWriteFile(join(dir, `${phase}.yaml`), yamlStringify(entry));
}

/**
 * Read every `<phase>.yaml` for a task into the `TaskGetLedgerResult` shape.
 * Absent dir → empty ledger (no throw). A malformed `<phase>.yaml` is skipped,
 * not fatal — one bad file must not blind the whole ledger (same no-throw-read
 * discipline as the session-state + active-task helpers).
 */
export async function readPhaseLedger(taskId: string): Promise<PhaseLedger> {
  const dir = phaseLedgerDir(taskId);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return { task_id: taskId, phases_logged: [], entries: [] };
  }
  const entries: PhaseLedgerEntry[] = [];
  for (const name of names) {
    if (!name.endsWith('.yaml')) continue;
    try {
      const parsed = yamlParse(await readFile(join(dir, name), 'utf8')) as unknown;
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        typeof (parsed as PhaseLedgerEntry).phase === 'string' &&
        typeof (parsed as PhaseLedgerEntry).logged_at === 'string'
      ) {
        entries.push(parsed as PhaseLedgerEntry);
      }
    } catch {
      // skip a malformed / unreadable file
    }
  }
  return { task_id: taskId, phases_logged: entries.map((e) => e.phase), entries };
}
