/**
 * LSF.2 — the wg-keyed phase store + the generic `setLoopPhase` primitive.
 *
 * THE central core/pack-boundary piece (subprocess-harness-push.md §2a — "getting this wrong is a real leak").
 * Today's 7-phase ledger is SESSION-keyed (`log_phase` → `readPhaseState(sessionId)`, workflow_phases.ts): a
 * headless-lap status formatter has NO session handle and reads by the canonical `wg-` id. So the live feed
 * needs a SEPARATE, wg-keyed store — this one — that the fullstack-flow PACK writes at its own phase boundaries.
 *
 * CORE = pack-agnostic MECHANISM. `setLoopPhase(wgId, phase, index, total)` is a GENERIC phase writer: it takes
 * an OPAQUE phase STRING (never a stage literal, never a fixed phase vocabulary) and attaches it to the item.
 * The reader (`collectLoopState`) drops a phase once the item's checkpoint stage has moved on (a phase is only
 * shown for the item's CURRENT stage), so core carries no notion of "which phase belongs to which stage" — it
 * stamps whatever the pack emits. `index`/`total` are the L2 progress counters (e.g. 4/7); both optional so a
 * stage with un-enumerated phases can still emit a bare label. Extensible to an L3 sub-step later WITHOUT a
 * schema change (additive columns).
 *
 * POLICY (labels, cadence, WHEN to emit) lives entirely in the fullstack-flow pack's per-stage procedures,
 * which CALL this primitive (via the `set_loop_phase` MCP tool) at their real phase boundaries — universal
 * across scope/plan/author/code/deploy, CODE's 7 phases included. Core `log_phase` is unchanged and emits NO
 * stage vocabulary.
 *
 * Imports from: @libsql/client, ./loop_db.js.
 * Imported by: src/mcp/tools/set_loop_phase.ts (the emit primitive), ./loop_state.ts (the reader).
 */
import type { Client } from '@libsql/client';

import { withLoopDb } from './loop_db.js';

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS loop_phases (
    wg_id TEXT PRIMARY KEY,
    phase TEXT NOT NULL,
    phase_index INTEGER,
    phase_total INTEGER,
    updated_at_ms INTEGER NOT NULL
  );
`;

/** One wg-keyed phase row (the item's CURRENT phase within its current stage). */
export interface LoopPhaseRow {
  wgId: string;
  phase: string;
  phaseIndex: number | null;
  phaseTotal: number | null;
  updatedAtMs: number;
}

async function ensureTable(db: Client): Promise<void> {
  await db.execute(CREATE_TABLE_SQL);
}

/**
 * THE generic emit primitive. Upsert the item's current phase (one row per wg id — a phase advance overwrites the
 * prior one). Opaque `phase` string; `index`/`total` are optional L2 counters (pass `null` to omit). Pure
 * mechanism: no stage vocabulary, no validation of the label against any pack.
 */
export async function setLoopPhase(
  wgId: string,
  phase: string,
  index: number | null,
  total: number | null,
  nowMs: number = Date.now(),
): Promise<void> {
  await withLoopDb(async (db) => {
    await ensureTable(db);
    await db.execute({
      sql: `INSERT INTO loop_phases (wg_id, phase, phase_index, phase_total, updated_at_ms)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(wg_id) DO UPDATE SET
              phase = excluded.phase,
              phase_index = excluded.phase_index,
              phase_total = excluded.phase_total,
              updated_at_ms = excluded.updated_at_ms`,
      args: [wgId, phase, index, total, nowMs],
    });
  });
}

/** Read every wg-keyed phase row (the whole board), for the read-model to merge onto the stage rows. */
export async function listLoopPhases(): Promise<LoopPhaseRow[]> {
  return withLoopDb(async (db) => {
    await ensureTable(db);
    const rs = await db.execute(
      `SELECT wg_id, phase, phase_index, phase_total, updated_at_ms FROM loop_phases`,
    );
    return rs.rows.map((row) => ({
      wgId: typeof row.wg_id === 'string' ? row.wg_id : '',
      phase: typeof row.phase === 'string' ? row.phase : '',
      phaseIndex: row.phase_index === null ? null : Number(row.phase_index),
      phaseTotal: row.phase_total === null ? null : Number(row.phase_total),
      updatedAtMs: Number(row.updated_at_ms),
    }));
  });
}
