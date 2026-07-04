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

import { readProcedureContent } from './read_procedure.js';
import { readRubricContent } from './read_rubric.js';
import { serializePlan } from './serialize_plan.js';

const PRE_RESEARCH_PATH_KEY = 'fullstack-flow-pre-research-path';

/** The stages that also carry an audit rubric (deploy has a procedure but no rubric). */
export const RUBRIC_STAGES = new Set<string>(['scope', 'plan', 'author', 'code']);

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

/**
 * PROCEDURE INTEGRITY — the standing anti-gaming invariant, prepended to EVERY stage bundle (so it rides every
 * stage, not just CODE). Authored from the observed failure mode (an agent, when blocked, reaches for a signal it
 * CONTROLS to fake the done-ness it hasn't earned). Each named vector is one we have actually seen exploited:
 * phantom phase-logging, task-status flips, `--no-verify`, and scope-diluting bundles. The gates re-derive the
 * verdict from the ARTIFACT, so none of these change the real state — they only waste a cycle and get caught.
 */
const PROCEDURE_INTEGRITY = [
  '🛑 PROCEDURE INTEGRITY — the gates measure the WORK, not signals you control. A blocked gate is INFORMATION',
  '(the work is not ready / the procedure is not complete), NOT a wall to route around. When blocked, do NOT reach',
  'for a signal you control to declare done-ness you have not earned:',
  '  • logging a phase you have not GENUINELY completed — the content-audit re-derives it from the artifact and',
  '    will catch it (a logged-but-undone phase fails the audit);',
  '  • marking the task complete / flipping its status;',
  '  • `git commit --no-verify` — a HUMAN-only override, never your shortcut, and never something you assume;',
  '  • bundling unrelated concerns into one commit to dilute scope (the audit flags scope-widening).',
  'Each is gaming; it does not make the work done. The ONLY unblock is to do the actual work, scoped to ONE concern,',
  'until the audit genuinely returns GUESS_FREE.',
].join('\n');

/**
 * THE 3× 100% — the standing TARGET prepended to every stage bundle (paired with PROCEDURE_INTEGRITY: that one
 * says don't fake done-ness, this one says what done genuinely means). #1 + #2 are GATE-ENFORCED (zero-LLM
 * predicates — you cannot pass without them); #3 a hard gate cannot fully verify (reaching the RIGHT external
 * source / "is this the best" is content-judgment, not a token-check), so it is on the agent to always drive it —
 * "the gate didn't force it" is NEVER permission to skip it. The audit checks #3 reached the external rung.
 */
const THE_3X_100 = [
  '🎯 THE 3× 100% — drive EVERY task toward all three, always:',
  '  1. 100% EVIDENCE — every load-bearing claim carries a citation (`file:line` / the design-of-record / the',
  "     user's words); nothing asserted. [GATE-ENFORCED: evidence-or-flag + the anchors check]",
  '  2. 100% COVERAGE — the work covers EVERY scoped/design element, no silent gaps (or a NAMED, tracked',
  '     deferral). [GATE-ENFORCED: the coverage checker]',
  '  3. 100% CONFIDENCE — reach the primary EXTERNAL sources to answer "what did I miss / is this the best /',
  '     does this match the docs"; local-only cannot. [NOT fully gateable — YOU must drive it every task; the',
  '     audit checks you reached the external rung. "The gate did not force it" is NEVER permission to skip it.]',
].join('\n');

/**
 * The standardized stage bundle [PROCEDURE-INTEGRITY, 3×100%, CHECKPOINT, PROCEDURE, RUBRIC, WORK-CONTEXT] as plain text.
 * The hook path (`stage_inject`, the only direct caller) assembles it — and that is ALSO how it reaches the
 * per-stage subprocess loop (T-v2-per-stage-loop PSL.3): the loop does NOT assemble this bundle itself (it primes
 * each lap with only the narrow `perStageDirective`); each lap is a fresh `claude` session whose OWN `stage_inject`
 * hook injects this bundle. So it is the single source that backs both surfaces, via the one `stage_inject` caller.
 * Takes the already-read `fsm` (the caller has it — the stage IS `fsm.state` + the checkpoint needs its
 * history), so there is no event/EvalCtx coupling and no double-read. Returns '' when the stage has NO procedure
 * (a terminal/decision FSM state) or every slot is empty → the caller injects nothing. Empty slots drop out.
 */
export async function buildStageBundle(
  sessionId: string,
  packId: string,
  fsm: FsmStateFile,
): Promise<string> {
  const stage = fsm.state;
  // NEED-TO-KNOW: only THIS stage's procedure. No file (terminal/decision state) → nothing to inject.
  const procedure = await readProcedureContent(stage, packId);
  if (procedure === null) return '';
  const rubric = RUBRIC_STAGES.has(stage) ? await readRubricContent(stage, packId) : null;
  const checkpoint = renderCheckpoint(fsm);
  const work = await stageWorkContext(stage, sessionId);
  // PROCEDURE_INTEGRITY (don't fake done-ness) + THE_3X_100 (what done means) lead every bundle — read first.
  return [PROCEDURE_INTEGRITY, THE_3X_100, checkpoint, procedure, rubric, work]
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .join('\n\n');
}
