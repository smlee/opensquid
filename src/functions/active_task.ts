/**
 * AP.4 — read-side primitives for the workflow gate.
 *
 *   - `has_active_task` — is there an active task this session, and what is it?
 *     Used by the workflow gate (rule #8) AND the scope→task Gate A (AP.5).
 *   - `workflow_phases_complete` — are all 7 REQUIRED phases logged for the
 *     CURRENTLY-active task? Computed at read time against the live active task
 *     (so a new task never inherits a prior task's completion — see
 *     workflow_phases.ts).
 *
 * Both are read-only, no args, never throw (a read failure surfaces as
 * "no active task" / "not complete" — the conservative verdict, NOT fail-open
 * past the gate). `memoizable: false` is load-bearing: the active task +
 * phase ledger change within a session, so a memoized result would be stale.
 *
 * Imports from: zod, ../runtime/result.js, ../runtime/session_state.js,
 *   ../runtime/workflow_phases.js.
 * Imported by: src/runtime/bootstrap.ts (registry wiring).
 */

import { z } from 'zod';

import { err, ok } from '../runtime/result.js';
import { readActiveTask } from '../runtime/session_state.js';
import { isComplete, readPhaseState } from '../runtime/workflow_phases.js';

import type { FunctionDef } from './registry.js';

const NoArgs = z.object({}).strict();

interface HasActiveTaskResult {
  present: boolean;
  /** Harness numeric id, or '' when none. */
  id: string;
  /** Provenance track id (metadata.taskId), or '' when none — Gate A (AP.5) keys on this. */
  task_id: string;
}

export const HasActiveTask: FunctionDef<z.input<typeof NoArgs>, HasActiveTaskResult> = {
  name: 'has_active_task',
  argSchema: NoArgs,
  durable: false,
  memoizable: false,
  costEstimateMs: 2,
  execute: async (_args, ctx) => {
    try {
      const active = await readActiveTask(ctx.sessionId);
      if (active === null) return ok({ present: false, id: '', task_id: '' });
      return ok({ present: true, id: active.id, task_id: active.taskId ?? '' });
    } catch (e) {
      return err({ kind: 'runtime' as const, message: `has_active_task: ${String(e)}`, cause: e });
    }
  },
};

interface WorkflowPhasesCompleteResult {
  /** Whether there is an active task at all. */
  active: boolean;
  /** True ⟺ an active task exists AND all 7 REQUIRED phases are logged for it. */
  complete: boolean;
}

export const WorkflowPhasesComplete: FunctionDef<
  z.input<typeof NoArgs>,
  WorkflowPhasesCompleteResult
> = {
  name: 'workflow_phases_complete',
  argSchema: NoArgs,
  durable: false,
  memoizable: false,
  costEstimateMs: 3,
  execute: async (_args, ctx) => {
    try {
      const active = await readActiveTask(ctx.sessionId);
      if (active === null) return ok({ active: false, complete: false });
      const state = await readPhaseState(ctx.sessionId);
      return ok({ active: true, complete: isComplete(state, active.id) });
    } catch (e) {
      return err({
        kind: 'runtime' as const,
        message: `workflow_phases_complete: ${String(e)}`,
        cause: e,
      });
    }
  },
};
