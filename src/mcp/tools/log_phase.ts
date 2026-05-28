/**
 * `log_phase` MCP tool — the agent-facing writer the G-track severed (AP.3).
 *
 * Given a phase name, it writes BOTH halves the gate depends on:
 *   (a) the engine ledger (durable, append-only) via `task.log_phase`, and
 *   (b) the session phase-state the workflow gate (AP.4) reads.
 *
 * Phases CANNOT be mirrored from any store (no store records "which phase the
 * agent just finished") — so this is necessarily agent-driven. Skipping it is
 * nonetheless caught: the rule #8 gate blocks the commit until all phases are
 * logged. Enforcement is autonomous; the action is the agent's.
 *
 * Session resolution: the MCP server is a SEPARATE process from the hooks, so
 * it reads `.current-session` (the live pointer the UserPromptSubmit hook
 * records — the same mechanism the `automation` CLI uses) to find the session,
 * then `active-task.json` for the task to log against. No active task → loud
 * error (you cannot log a phase with no task — ties to rule #1).
 *
 * No agent-loop logic: opensquid persists what the agent declares + bridges to
 * the engine. Engine type imported directly so an RPC shape change fails
 * typecheck here.
 *
 * Imports from: zod, ../../engine/client.js, ../../runtime/*.
 * Imported by: mcp/server.ts (handler map).
 */

import { z } from 'zod';

import type { EngineClient } from '../../engine/client.js';
import { transitionChainStage } from '../../runtime/chain_state.js';
import { readCurrentSession } from '../../runtime/hooks/session_id.js';
import { readActiveTask } from '../../runtime/session_state.js';
import { REQUIRED_PHASES, appendPhase, isComplete } from '../../runtime/workflow_phases.js';

export const LogPhaseSchema = z.object({
  phase: z.enum(REQUIRED_PHASES).describe('One of the 7 workflow phases'),
  note: z.string().optional().describe('Optional free-text note recorded in the engine ledger'),
});

export type LogPhaseArgs = z.infer<typeof LogPhaseSchema>;

export interface LogPhaseOutput {
  ok: true;
  task_id: string;
  phase: string;
  /** Phases logged so far for the active task. */
  phases_logged: string[];
  /** True once all 7 REQUIRED phases are present (the gate then unblocks commit). */
  complete: boolean;
}

export async function handleLogPhase(
  args: LogPhaseArgs,
  engine: EngineClient,
): Promise<LogPhaseOutput> {
  const sessionId = await readCurrentSession();
  if (sessionId === null) {
    throw new Error(
      'log_phase: no live session (.current-session absent). Cannot resolve the active task.',
    );
  }
  const active = await readActiveTask(sessionId);
  if (active === null) {
    throw new Error(
      'log_phase: no active task (active-task.json absent). Create a task and set it in_progress first (rule #1).',
    );
  }
  // (a) durable engine ledger
  await engine.taskLogPhase({
    task_id: active.id,
    phase: args.phase,
    ...(args.note !== undefined ? { note: args.note } : {}),
  });
  // (b) gate-readable session state
  const state = await appendPhase(sessionId, active.id, args.phase);
  const complete = isComplete(state, active.id);
  // ASC.1 — chain-state transition. log_phase is the canonical signal for
  // 7-phase progress: at least one phase logged ⇒ 'phases_in_flight'; all 7
  // REQUIRED phases logged ⇒ 'phases_complete'. Silent fail-open: this MCP
  // tool's return shape is the gate's contract, and a chain-state-write
  // failure must NOT propagate into the tool response. The transition is
  // idempotent on same-stage, so re-logging an already-counted phase is a
  // no-op for the chain (the phase-state still appends to the engine ledger
  // and the session phase-state via appendPhase above).
  try {
    await transitionChainStage(sessionId, complete ? 'phases_complete' : 'phases_in_flight');
  } catch {
    /* silent: chain-state plumbing must never disturb log_phase's return */
  }
  return {
    ok: true,
    task_id: active.id,
    phase: args.phase,
    phases_logged: state.phases,
    complete,
  };
}
