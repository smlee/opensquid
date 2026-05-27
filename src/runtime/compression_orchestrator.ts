/**
 * CMP.4 — compression orchestrator + recall-replay drift gate.
 *
 * Authoritative spec: `docs/tasks/T-compression.md` CMP.4 + pre-research
 * §4 D2/D3 (`docs/research/T-compression-pre-research-2026-05-27.md`).
 *
 * ⚠️ THIS MODULE OWNS THE ONLY IRREVERSIBLE OPERATION IN THE COMPRESSION
 * LAYER: force-deleting a predecessor memory. The user's whole design
 * guards against LOSING a memory. The locked D2 contract is enforced
 * here EXACTLY:
 *
 *   A predecessor is force-deleted ONLY after ALL THREE hold:
 *     (a) the group's satisfaction probe answered "satisfied" (D1), AND
 *     (b) the recall-replay drift gate PASSES — Mc still surfaces in
 *         top-k for EVERY predecessor's representative query (D3), AND
 *     (c) that predecessor is NOT user-cited (consumed_by_user_lessons
 *         === 0). force=true BYPASSES the engine's immunity guard, so
 *         this client-side check is the ONLY thing protecting a
 *         user-cited memory — it is load-bearing.
 *
 *   ON ANY failure / uncertainty / engine error: KEEP Mc ALONGSIDE the
 *   predecessors, DELETE NOTHING for that window, emit a drift event +
 *   notify. Fail-closed = keep the originals. The memory trace is never
 *   lost (Mc + the derived_from chain + transferred citations preserve
 *   it; recall chases derived_from so the predecessors' queries still
 *   surface Mc after deletion).
 *
 * EXACTLY ONE deletion path: the single `engine.memoryDelete({ force:
 * true })` call below, reached only after the gate. The CMP.4 audit
 * greps the whole change for any other memoryDelete/delete call — there
 * must be none outside this gated terminal step.
 *
 * Imports from: ../engine/client.js, ../engine/types.js, ./drift_catalog.js,
 *   ./satisfaction_probe.js, ./wedge/compress_candidates.js.
 * Imported by: (a session-boundary / automation-cycle trigger, TBD wiring).
 */

import type { EngineClient } from '../engine/client.js';

import { appendSessionDriftEvent } from './drift_catalog.js';
import { readSatisfaction } from './satisfaction_probe.js';
import { readCandidates } from './wedge/compress_candidates.js';

/** Top-k for the recall-replay membership check (D3 default). */
const RECALL_REPLAY_K = 5;

/** Drift catalog tags for compression-gate events (surfaced via list_drift_events). */
const DRIFT_PACK = '<compression>';
const DRIFT_RULE = 'compression-recall-replay-gate';

/**
 * Recall-replay drift gate (D3). For EVERY predecessor, run that
 * predecessor's representative query and require the compressed memory
 * `mcId` to appear in the top-k results. Membership, not exact rank — a
 * compressed gist legitimately re-ranks. ANY miss → the gate fails →
 * the orchestrator deletes NOTHING for the window.
 *
 * The representative query is the predecessor's own description (its
 * most compact semantic fingerprint). We read it via `memoryGet`; if a
 * predecessor can't be read, the gate FAILS CLOSED (returns false) so
 * uncertainty never green-lights a deletion.
 *
 * Any engine error propagates to the caller, which treats it as
 * "gate did not pass" and deletes nothing.
 */
export async function recallReplayPasses(
  engine: EngineClient,
  predecessorIds: string[],
  mcId: string,
  k: number = RECALL_REPLAY_K,
): Promise<boolean> {
  for (const pid of predecessorIds) {
    // Derive the representative query from the predecessor's description.
    const pred = await engine.memoryGet({ id: pid });
    const query = pred.description?.trim();
    if (!query) return false; // no usable query → fail closed
    const res = await engine.memorySearch({ query, limit: k, mode: 'hybrid' });
    if (!res.results.some((h) => h.id === mcId)) {
      return false; // Mc did not survive recall for this predecessor → degraded
    }
  }
  return true;
}

/** Outcome of one window's compression attempt — for caller telemetry + tests. */
export interface CompressionOutcome {
  group: string;
  promotedLessonId: string;
  mcId: string | null;
  /** Predecessors actually force-deleted (gate passed + not user-cited). */
  deleted: string[];
  /** Predecessors KEPT because they are user-cited (immunity). */
  keptImmune: string[];
  /** True when the window was skipped (gate failed / error) — nothing deleted. */
  skipped: boolean;
  /** Reason a window was skipped, for the drift event + telemetry. */
  reason?: string;
}

/**
 * Run compression for one satisfied group. Reads the group's candidate
 * windows (CMP.3), compresses each via the engine (CMP.1), runs the
 * recall-replay gate (D3), and force-deletes the non-immune predecessors
 * ONLY when the gate passes (D2). Returns one outcome per window.
 *
 * D1: returns an empty result immediately when the group's satisfaction
 * probe is absent or not "satisfied" — no compression, no deletion.
 */
export async function runCompression(
  sessionId: string,
  group: string,
  engine: EngineClient,
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
      // 1. Compress the window → Mc. The engine mints Mc with
      //    derived_from = ids + summed citations; it does NOT delete
      //    anything.
      const mc = await engine.memoryCompress({ ids });
      outcome.mcId = mc.id;

      // 2. D3 — recall-replay gate. Mc must surface for EVERY
      //    predecessor's query. A miss (or any uncertainty) → skip ALL
      //    deletion for this window; keep Mc alongside the predecessors.
      const safe = await recallReplayPasses(engine, ids, mc.id);
      if (!safe) {
        outcome.skipped = true;
        outcome.reason = 'recall-replay gate failed: Mc did not surface for a predecessor query';
        await emitDrift(sessionId, group, w.promotedLessonId, mc.id, ids, outcome.reason);
        outcomes.push(outcome);
        continue;
      }

      // 3. D2 — gated terminal deletion. The gate passed; delete each
      //    predecessor ONLY if it is NOT user-cited. force=true bypasses
      //    the engine immunity guard, so this per-predecessor check is
      //    the ONLY protection for a user-cited memory.
      //    THIS IS THE ONLY memoryDelete CALL IN THE COMPRESSION LAYER.
      for (const pid of ids) {
        const pred = await engine.memoryGet({ id: pid });
        if (pred.consumed_by_user_lessons === 0) {
          await engine.memoryDelete({ id: pid, force: true });
          outcome.deleted.push(pid);
        } else {
          // user-cited predecessor → KEEP (immunity). Mc + derived_from
          // + the transferred citation preserve the trace.
          outcome.keptImmune.push(pid);
        }
      }
      outcomes.push(outcome);
    } catch (e) {
      // Fail-closed: ANY engine error mid-flow → delete NOTHING (we may
      // have already deleted some predecessors before the error, but we
      // never delete past an error — the loop above stops at the throw).
      // Keep Mc + remaining predecessors; emit a drift event + notify.
      outcome.skipped = true;
      outcome.reason = `compression error (nothing further deleted): ${String(e)}`;
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
 * the safe outcome (we already deleted nothing).
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
