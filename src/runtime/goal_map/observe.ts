/**
 * GOAL-MAPPER.2 — the per-slice worksheet TRIGGER, as a single observe hook on FSM advances.
 *
 * Called WRAPPED from `advanceFsmState` (next to the P0.2 `appendTransition` seed, inside
 * `if (result.transitioned)`, downstream of persistence) — so it fires once per ACTUAL advance and
 * never breaks the advance (observe-don't-control). It owns the slice-begin/link rules so
 * `fsm_state` stays generic (it knows nothing of `'scoping'`):
 *   - `to === 'scoping'`     → START a per-slice worksheet (every slice-begin path: scope_start +
 *                              task_unscoped all land here; the `if (transitioned)` guard makes it once-per-slice)
 *   - `to === 'tasks_loaded'`→ LINK the active task's id onto the open worksheet
 *
 * cwd is SESSION-derived (`readSessionCwd`), never `process.cwd()` (advanceFsmState also runs in the
 * persistent MCP server, where cwd ≠ the project). No goal-map set → no-op (surfaced, not blocked).
 */
import { OPENSQUID_HOME } from '../paths.js';
import { readActiveTask, readSessionCwd } from '../session_state.js';
import { readGoalMap, writeGoalMap } from './goal_map.js';
import { linkTaskId, startWorksheet } from './mapper.js';

export async function observeGoalTransition(rec: {
  session: string;
  to: string;
  now: string; // the ISO string advanceFsmState already carries
}): Promise<void> {
  if (rec.to !== 'scoping' && rec.to !== 'tasks_loaded') return; // only slice-begin + taskId-link matter
  const cwd = (await readSessionCwd(rec.session)) ?? OPENSQUID_HOME();
  const gm = await readGoalMap(cwd);
  if (gm === null) return; // no goal declared → no worksheet (surfaced, not blocked)
  if (rec.to === 'scoping') {
    await writeGoalMap(cwd, startWorksheet(gm, rec.now, rec.now)); // sliceId = the begin timestamp
    return;
  }
  // tasks_loaded → link the active task's id onto the open worksheet (best-effort)
  const active = await readActiveTask(rec.session);
  if (active?.taskId) await writeGoalMap(cwd, linkTaskId(gm, active.taskId));
}
