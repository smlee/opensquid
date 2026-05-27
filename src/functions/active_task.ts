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

import { stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

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

interface HasGeneratedSpecResult {
  /** Whether there is an active task at all. */
  present: boolean;
  /** True ⟺ the active task carries a `spec` provenance path that resolves on disk. */
  generated: boolean;
}

async function pathExistsAbs(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Does the active task have GENERATOR PROVENANCE — a `docs/tasks` 11-field spec
 * the scope→task pipeline produced? Backs scope→task Gate A (AP.5): a code-write
 * whose active task has no generated spec is blocked.
 *
 * Provenance = `active-task.json.spec` (copied by the AP.1 mirror from the
 * harness `metadata.spec`) resolving to a real file. H7: the spec lives in the
 * loop PLANNING repo while the code-write is in another repo, so an ABSOLUTE
 * `spec` is checked directly; a relative one is resolved against the event cwd
 * (the same-repo case). No active task OR no spec OR a dangling path → not
 * generated (the conservative verdict — Gate A then blocks "scope it first").
 */
export const HasGeneratedSpec: FunctionDef<z.input<typeof NoArgs>, HasGeneratedSpecResult> = {
  name: 'has_generated_spec',
  argSchema: NoArgs,
  durable: false,
  memoizable: false,
  costEstimateMs: 4,
  execute: async (_args, ctx) => {
    try {
      const active = await readActiveTask(ctx.sessionId);
      if (active === null) return ok({ present: false, generated: false });
      const spec = active.spec;
      if (spec === undefined || spec === '') return ok({ present: true, generated: false });
      const cwd = ctx.event.kind === 'tool_call' ? (ctx.event.cwd ?? process.cwd()) : process.cwd();
      const specPath = isAbsolute(spec) ? spec : resolve(cwd, spec);
      return ok({ present: true, generated: await pathExistsAbs(specPath) });
    } catch (e) {
      return err({
        kind: 'runtime' as const,
        message: `has_generated_spec: ${String(e)}`,
        cause: e,
      });
    }
  },
};
