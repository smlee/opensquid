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

import { readHarnessTasks } from '../runtime/hooks/active_task_mirror.js';
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

interface TaskListGeneratedResult {
  /** True ⟺ every open (pending/in_progress) task carries a `metadata.taskId` provenance stamp. */
  all_generated: boolean;
  /** Harness ids of open tasks missing the provenance stamp (the smuggled-in tasks). */
  ungenerated: string[];
}

/**
 * Gate B (AP.5) read-side: does the ENTIRE open task list have generator
 * provenance? Walks the harness store (via AP.1's isolated reader) and flags any
 * pending/in_progress task lacking `metadata.taskId` — the stamp scope→task
 * generation applies (H6). Closes Gate A's loophole: a task smuggled into the
 * list manually (no spec, no pre-research) would otherwise let code through once
 * loaded. Completed/deleted tasks are ignored (only open work must be generated).
 */
export const TaskListGenerated: FunctionDef<z.input<typeof NoArgs>, TaskListGeneratedResult> = {
  name: 'task_list_generated',
  argSchema: NoArgs,
  durable: false,
  memoizable: false,
  costEstimateMs: 5,
  execute: async (_args, ctx) => {
    try {
      // ATM.2: THIS CC version keeps the task list in the session transcript,
      // not ~/.claude/tasks/. The UPS hook (which has transcript_path; this
      // function layer does not) derives the open-task list onto
      // `event.openTasks` for the prompt_submit Gate B fires on. Prefer it;
      // fall back to the harness-store read for older CC / non-UPS events.
      const ev = ctx.event;
      const open =
        ev.kind === 'prompt_submit' && ev.openTasks !== undefined
          ? ev.openTasks
          : (await readHarnessTasks(ctx.sessionId)).map((t) => ({
              id: t.id,
              status: t.status,
              taskId: t.metadata?.taskId,
            }));
      const ungenerated = open
        .filter((t) => t.status === 'pending' || t.status === 'in_progress')
        .filter((t) => t.taskId === undefined || t.taskId === '')
        .map((t) => t.id);
      return ok({ all_generated: ungenerated.length === 0, ungenerated });
    } catch (e) {
      return err({
        kind: 'runtime' as const,
        message: `task_list_generated: ${String(e)}`,
        cause: e,
      });
    }
  },
};
