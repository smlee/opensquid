/**
 * GOAL-MAPPER.1 — the per-slice mapper: a worksheet/checkpoint started on every slice.
 *
 * Each slice (a SCOPE→AUTHOR→CODE run = one task) gets a Worksheet anchored to the goal-map's
 * goal — recording WHAT the slice does + HOW it serves the goal (the anti-drift anchor the
 * process-FSM lacks). PURE: `startWorksheet` returns a new GoalMap; the caller persists. The mapper
 * never advances FSM state nor publishes on the bus — observe-don't-control, so it cannot
 * taint the engine's total-transition determinism.
 *
 * `sliceId = the slice's taskId` (one TaskCreate per slice), which bridges to the existing
 * taskId-keyed phase ledgers (`phase_ledger`/`workflow_phases`) — the mapper owns no ledger.
 */
import type { GoalMap } from './goal_map.js';

/** A per-slice checkpoint: what this slice is + how it ties to the goal. */
export interface Worksheet {
  sliceId: string; // = the slice's taskId
  startedAt: string; // ISO
  goalRef: string; // the goal this slice serves (snapshot of GoalMap.goal at start)
  intent: string; // what THIS slice does, in service of the goal (the anti-drift anchor)
}

/** Start a per-slice worksheet/checkpoint anchored to the current goal. PURE — caller persists. */
export function startWorksheet(gm: GoalMap, sliceId: string, intent: string, now: Date): GoalMap {
  const ws: Worksheet = { sliceId, startedAt: now.toISOString(), goalRef: gm.goal, intent };
  return { ...gm, worksheets: [...gm.worksheets, ws] };
}
