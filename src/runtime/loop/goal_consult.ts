// T2.10 — goal-map consultation at SCOPE (design §6.3).
//
// The shipped goal-map is the captured top-level objective (the destination). At SCOPE we check, DETERMINISTICALLY
// and ADVISORY (no LLM, never a block — the anti-drift gate is checkAnchors; this is the human-readable destination
// check), whether the captured ask still points at the goal. The value is SURFACED in the SCOPE-stage report
// (T2.12) as the `## Goal alignment` line — the live consumer (not a dormant binding).

import { readCapturedAsk } from '../coverage/captured_ask.js';
import { readGoalMap } from '../goal_map/goal_map.js';

export interface GoalConsult {
  hasGoal: boolean;
  aligned: boolean;
  goal: string;
}

export async function goalConsult(sessionId: string, cwd: string): Promise<GoalConsult> {
  const gm = await readGoalMap(cwd);
  if (gm === null || gm.goal === '') return { hasGoal: false, aligned: true, goal: '' }; // no goal → not a drift signal
  const ask = (await readCapturedAsk(sessionId)).turns.join('\n').toLowerCase();
  // deterministic destination check: the goal's salient tokens (len > 4) appear in the captured ask (same scope)
  const tokens = gm.goal
    .toLowerCase()
    .split(/\W+/)
    .filter((t) => t.length > 4);
  const aligned = tokens.length === 0 || tokens.some((t) => ask.includes(t));
  return { hasGoal: true, aligned, goal: gm.goal };
}
