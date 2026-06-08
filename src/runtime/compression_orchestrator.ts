/**
 * CMP.4 — compression orchestrator (THIN policy caller).
 *
 * Authoritative spec: `docs/tasks/T-compression.md` CMP.4 (the
 * "⚠️ ARCHITECTURE REVISION" block) + pre-research §4 D1/D2/D3
 * (`docs/research/T-compression-pre-research-2026-05-27.md`).
 *
 * ⚠️ ARCHITECTURE REVISION (2026-05-27): the verify+delete safety
 * contract MOVED INTO the loop-engine (`memory.consolidate`). The
 * loop-engine is a UNIVERSAL substrate, so recall-replay verification +
 * gated non-immune predecessor deletion is universal memory INTEGRITY
 * every consumer needs — NOT opensquid policy. The engine guarantees
 * the safe-HOW (atomic, race-free, fail-closed); opensquid decides the
 * WHEN/WHAT.
 *
 * THIS MODULE NO LONGER ISSUES ANY `memory.delete` AND NO LONGER RUNS
 * RECALL-REPLAY. Both now live inside the engine's `memory.consolidate`
 * op. opensquid's role is purely policy:
 *
 *   D1 (WHEN): only run for a group whose satisfaction probe answered
 *     "satisfied". No satisfied probe → no-op (return []).
 *   WHAT: read the group's CMP.3 candidate windows; call
 *     the TS `consolidate(ids)` (RES-4b) per window — engine-free.
 *   SURFACE: report the engine's outcome (deleted / kept_immune /
 *     verified); emit a drift event when `!verified` (the engine kept
 *     `Mc` alongside the predecessors — nothing was lost, but the
 *     window wasn't safe to consolidate yet).
 *
 * The engine's `memory.consolidate` enforces the locked D2/D3 contract
 * internally: a predecessor is force-deleted ONLY after (a) compression
 * succeeds, (b) the recall-replay gate passes for EVERY predecessor,
 * and (c) that predecessor is not user-cited
 * (`consumed_by_user_lessons === 0`). Any failure → delete nothing,
 * `verified: false`. The memory trace is never lost.
 *
 * Imports from: ../engine/client.js, ./drift_catalog.js,
 *   ./satisfaction_probe.js, ./wedge/compress_candidates.js.
 * Imported by: (a session-boundary / automation-cycle trigger, TBD wiring).
 */

import type { ConsolidateOutcome } from '../rag/memory/consolidate.js';

import { appendSessionDriftEvent } from './drift_catalog.js';
import { readSatisfaction } from './satisfaction_probe.js';
import { readCandidates } from './wedge/compress_candidates.js';

/** Drift catalog tags for compression-gate events (surfaced via list_drift_events). */
const DRIFT_PACK = '<compression>';
const DRIFT_RULE = 'compression-recall-replay-gate';

/** Outcome of one window's consolidation attempt — for caller telemetry + tests. */
export interface CompressionOutcome {
  group: string;
  promotedLessonId: string;
  /** The minted compressed memory id (null only if compression itself failed). */
  mcId: string | null;
  /** Predecessors the engine force-deleted (verified + not user-cited). */
  deleted: string[];
  /** Predecessors the engine KEPT because they are user-cited (immunity). */
  keptImmune: string[];
  /**
   * True when nothing was deleted for this window — either the engine's
   * verify gate missed (`verified: false`) or a consolidate error. Mc
   * (if minted) is kept alongside the predecessors; the trace is intact.
   */
  skipped: boolean;
  /** Reason a window was skipped, for the drift event + telemetry. */
  reason?: string;
}

/**
 * Run consolidation for one satisfied group. Reads the group's
 * candidate windows (CMP.3) and calls the engine's atomic
 * `memory.consolidate` per window (CMP.1 bridge + the revised engine
 * op). Returns one outcome per window.
 *
 * D1: returns an empty result immediately when the group's satisfaction
 * probe is absent or not "satisfied" — no consolidation requested.
 *
 * The orchestrator does NOT verify recall-replay or delete predecessors
 * — the engine's `memory.consolidate` does both atomically and
 * fail-closed. opensquid only surfaces the result + emits drift on a
 * non-verified outcome.
 */
export async function runCompression(
  sessionId: string,
  group: string,
  consolidateWindow: (ids: string[]) => Promise<ConsolidateOutcome>,
): Promise<CompressionOutcome[]> {
  // D1 — only satisfied groups. No answered "satisfied" probe → no-op.
  const sat = (await readSatisfaction(sessionId)).find((s) => s.group === group);
  if (!sat?.satisfied) return [];

  const windows = await readCandidates(sessionId, group);
  const outcomes: CompressionOutcome[] = [];

  for (const w of windows) {
    const ids = [...new Set(w.ids)];
    const outcome: CompressionOutcome = {
      group,
      promotedLessonId: w.promotedLessonId,
      mcId: null,
      deleted: [],
      keptImmune: [],
      skipped: false,
    };

    try {
      // The TS consolidate (RES-4b) atomically: compress → recall-replay verify
      // → gated delete of non-immune predecessors. Same D2 contract, engine-free;
      // opensquid issues NO delete here (consolidate owns it, fail-closed).
      const res = await consolidateWindow(ids);
      outcome.mcId = res.mcId;
      outcome.deleted = res.deleted;
      outcome.keptImmune = res.keptImmune;

      if (!res.verified) {
        // Engine kept Mc alongside the predecessors (nothing deleted) —
        // the window wasn't safe to consolidate yet. Surface drift.
        outcome.skipped = true;
        outcome.reason =
          'recall-replay gate did not verify: Mc kept alongside predecessors, nothing deleted';
        await emitDrift(sessionId, group, w.promotedLessonId, res.mcId, ids, outcome.reason);
      }
      outcomes.push(outcome);
    } catch (e) {
      // A consolidate RPC error is fail-closed on the engine side (it
      // deletes nothing before it can verify). Surface it as a skipped
      // window + drift event.
      outcome.skipped = true;
      outcome.reason = `consolidate error (nothing deleted): ${String(e)}`;
      await emitDrift(sessionId, group, w.promotedLessonId, outcome.mcId, ids, outcome.reason);
      outcomes.push(outcome);
    }
  }

  return outcomes;
}

/**
 * Emit a drift event recording that a window's predecessors were KEPT
 * alongside Mc (nothing deleted), surfaced to the user via
 * `list_drift_events`. Best-effort — a drift-write failure must not mask
 * the safe outcome (the engine already deleted nothing).
 */
async function emitDrift(
  sessionId: string,
  group: string,
  promotedLessonId: string,
  mcId: string | null,
  predecessorIds: string[],
  reason: string,
): Promise<void> {
  try {
    await appendSessionDriftEvent(sessionId, {
      timestamp: new Date().toISOString(),
      pack: DRIFT_PACK,
      ruleId: DRIFT_RULE,
      level: 'surface',
      message: `compression kept Mc${mcId ? ` (${mcId})` : ''} alongside predecessors [${predecessorIds.join(
        ', ',
      )}] for group ${group} (lesson ${promotedLessonId}); nothing deleted — ${reason}`,
    });
  } catch {
    // never mask the safe (no-deletion) outcome on a logging failure
  }
}
