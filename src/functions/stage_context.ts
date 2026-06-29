/**
 * stage_context (#6) — the CHECKPOINT + per-stage WORK-CONTEXT slots of the standardized stage_inject bundle.
 *
 * The standardized bundle is [CHECKPOINT, PROCEDURE, RUBRIC, WORK-CONTEXT]; stage_inject already supplies
 * procedure + rubric. This adds the other two, NEED-TO-KNOW: the work-context is POINTERS/identifiers (where
 * the stage's input is), not full dumps — fewer vessels, leaner context. Empty slots drop out of the bundle.
 *
 * CHECKPOINT (universal): the current FSM stage + the path taken (history) — "where am I, how did I get here".
 * WORK-CONTEXT (per stage): scope→the goal · plan→the scope artifact to decompose · author→the plan (reuse
 * serializePlan) · code→the active task to implement · deploy→the acceptance status. All reuse shipped readers.
 */
import { readFile } from 'node:fs/promises';

import { type FsmStateFile } from '../runtime/fsm_state.js';
import { readGoalMap } from '../runtime/goal_map/goal_map.js';
import { readAcceptance } from '../runtime/loop/acceptance.js';
import { sessionStateFile } from '../runtime/paths.js';
import { readActiveTask, readSessionCwd } from '../runtime/session_state.js';

import { serializePlan } from './serialize_plan.js';

const PRE_RESEARCH_PATH_KEY = 'fullstack-flow-pre-research-path';

/** CHECKPOINT — where the run is: the current stage + the path taken (history). Empty when no FSM state. */
export function renderCheckpoint(fsm: FsmStateFile | null): string {
  if (fsm === null) return '';
  const path = fsm.history.map((h) => h.state).join(' → ') || fsm.state;
  return `📍 CHECKPOINT — stage: ${fsm.state} (entered ${fsm.started_at}). Path so far: ${path}.`;
}

/** Injectable readers (tests pass pure stubs); defaults reuse the shipped readers. */
export interface WorkContextDeps {
  goal: (sessionId: string) => Promise<string | null>;
  scopePath: (sessionId: string) => Promise<string | null>;
  plan: (sessionId: string) => Promise<string | null>;
  task: (sessionId: string) => Promise<{ id: string; subject: string; taskId?: string } | null>;
  acceptance: (sessionId: string) => Promise<string>;
}

async function defaultGoal(sessionId: string): Promise<string | null> {
  const cwd = await readSessionCwd(sessionId);
  if (cwd === null) return null;
  return (await readGoalMap(cwd))?.goal ?? null;
}

async function defaultScopePath(sessionId: string): Promise<string | null> {
  try {
    const v: unknown = JSON.parse(
      await readFile(sessionStateFile(sessionId, PRE_RESEARCH_PATH_KEY), 'utf8'),
    );
    return typeof v === 'string' && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

async function defaultAcceptance(sessionId: string): Promise<string> {
  try {
    const items = await readAcceptance(sessionId);
    return items.length === 0
      ? 'no acceptance item yet (human-accept pending)'
      : items.map((i) => `${i.id}: ${i.status}`).join('; ');
  } catch {
    return 'unknown';
  }
}

const defaultDeps: WorkContextDeps = {
  goal: defaultGoal,
  scopePath: defaultScopePath,
  plan: serializePlan,
  task: readActiveTask,
  acceptance: defaultAcceptance,
};

/** The stage's INPUT pointer (need-to-know). Empty string when absent → the slot drops out of the bundle. */
export async function stageWorkContext(
  stage: string,
  sessionId: string,
  deps: WorkContextDeps = defaultDeps,
): Promise<string> {
  switch (stage) {
    case 'scope': {
      const g = await deps.goal(sessionId);
      return g ? `🎯 GOAL (the destination this scope serves): ${g}` : '';
    }
    case 'plan': {
      const p = await deps.scopePath(sessionId);
      return p ? `INPUT — the SCOPE artifact to decompose: ${p}` : '';
    }
    case 'author': {
      const plan = await deps.plan(sessionId);
      return plan ? `INPUT — the PLAN to author specs for:\n${plan}` : '';
    }
    case 'code': {
      const t = await deps.task(sessionId);
      return t ? `INPUT — the active TASK to implement: ${t.taskId ?? t.id} — ${t.subject}` : '';
    }
    case 'deploy':
      return `ACCEPTANCE status: ${await deps.acceptance(sessionId)}`;
    default:
      return '';
  }
}
