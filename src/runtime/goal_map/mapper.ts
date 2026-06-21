/**
 * GOAL-MAPPER — the per-slice mapper: a worksheet/checkpoint started on every slice.
 *
 * Each slice (a SCOPE→AUTHOR→CODE run) gets a Worksheet anchored to the goal-map's goal — the
 * anti-drift anchor the process-FSM lacks. PURE: these return a new GoalMap; the caller persists.
 * The mapper never advances FSM state nor publishes on the bus — observe-don't-control, so it cannot
 * taint the engine's total-transition determinism.
 *
 * A worksheet is keyed by `sliceId` (the slice-begin timestamp — the FSM is session-level single-track,
 * so it's unique per slice); its `taskId` is LINKED later (at `tasks_loaded`) and bridges to the
 * existing taskId-keyed phase ledgers. The "what this slice does" lives in its pre-research/spec
 * (referenced via `taskId`), not duplicated here — the anchor is `goalRef` + the linked `taskId`.
 */
import type { GoalMap } from './goal_map.js';

/** A per-slice checkpoint: the slice, anchored to the goal it serves. */
export interface Worksheet {
  sliceId: string; // the slice-begin ISO timestamp (unique per single-track slice)
  startedAt: string; // ISO
  goalRef: string; // snapshot of GoalMap.goal at begin — the anti-drift anchor
  taskId?: string; // linked at tasks_loaded → the slice's pre-research/spec/ledger
}

/** Start a per-slice worksheet anchored to the current goal. `now` is an ISO string. PURE. */
export function startWorksheet(gm: GoalMap, sliceId: string, now: string): GoalMap {
  const ws: Worksheet = { sliceId, startedAt: now, goalRef: gm.goal };
  return { ...gm, worksheets: [...gm.worksheets, ws] };
}

/** Set `taskId` on the most-recent worksheet lacking one (the FSM is session-level single-track, so
 *  the last open worksheet IS the current slice). No open worksheet → no-op. PURE. */
export function linkTaskId(gm: GoalMap, taskId: string): GoalMap {
  const rev = [...gm.worksheets].reverse().findIndex((w) => w.taskId === undefined);
  if (rev < 0) return gm;
  const idx = gm.worksheets.length - 1 - rev;
  return { ...gm, worksheets: gm.worksheets.map((w, k) => (k === idx ? { ...w, taskId } : w)) };
}
