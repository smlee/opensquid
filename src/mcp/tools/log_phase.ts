/**
 * `log_phase` MCP tool — the agent-facing writer the G-track severed (AP.3).
 *
 * Given a phase name, it writes BOTH halves the gate depends on:
 *   (a) the durable phase ledger — TS-owned filesystem YAML via
 *       `runtime/phase_ledger.ts` (retire-Rust: replaced `engine.task.log_phase`
 *       with the same `~/.opensquid/phase_ledger/<task>/<phase>.yaml`), and
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
 * No agent-loop logic: opensquid persists what the agent declares. No engine
 * dependency — the durable ledger is TS-owned filesystem YAML.
 *
 * Imports from: zod, ../../runtime/*.
 * Imported by: mcp/server.ts (handler map).
 */

import { z } from 'zod';

import { resolveMcpSessionId } from '../../runtime/hooks/session_id.js';
import { writePhaseLedger } from '../../runtime/phase_ledger.js';
import { readActiveTask } from '../../runtime/session_state.js';
import { REQUIRED_PHASES, appendPhase, isComplete } from '../../runtime/workflow_phases.js';

export const LogPhaseSchema = z.object({
  phase: z.enum(REQUIRED_PHASES).describe('One of the 7 workflow phases'),
  note: z.string().optional().describe('Optional free-text note recorded in the phase ledger'),
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

export async function handleLogPhase(args: LogPhaseArgs): Promise<LogPhaseOutput> {
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
  // (a) durable phase ledger — TS-owned filesystem YAML (retire-Rust: was
  // engine.taskLogPhase; same `~/.opensquid/phase_ledger/<task>/<phase>.yaml`).
  await writePhaseLedger(active.id, args.phase, args.note);
  // (b) gate-readable session state
  const state = await appendPhase(sessionId, active.id, args.phase);
  const complete = isComplete(state, active.id);
  // The 7-phase progress signal is now consumed by the opt-in `coding-flow`
  // pack: its `phase-advance` skill fires on the PostToolUse hook for
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
