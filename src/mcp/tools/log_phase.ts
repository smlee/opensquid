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
import { resolveMcpSessionId } from '../../runtime/hooks/session_id.js';
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
  // T-MULTISESSION MS.1 — env-first session resolution (race-free across
  // concurrent Claude Code sessions). Falls back to .current-session when
  // env is absent.
  const sessionId = await resolveMcpSessionId();
  if (sessionId === null) {
    throw new Error(
      'log_phase: cannot resolve session — no CLAUDE_SESSION_ID env, no ' +
        'OPENSQUID_SESSION_ID env, and .current-session absent.',
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
  // The 7-phase progress signal is now consumed by the opt-in `workflow-fsm`
  // pack: its `advance-on-phase-log` skill fires on the PostToolUse hook for
  // this MCP call and advances the lifecycle FSM (re-deriving completeness via
  // workflow_phases_complete). log_phase no longer writes a global chain stage.
  return {
    ok: true,
    task_id: active.id,
    phase: args.phase,
    phases_logged: state.phases,
    complete,
  };
}
