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
 * scope-1 (T-deterministic-phase-monitor) — this ENFORCED write ALSO drives the wg-keyed phase monitor event, so
 * CODE's 7 phases always show on the live feed WITHOUT the agent calling the discretionary `set_loop_phase`.
 *
 * Imports from: zod, ../../runtime/* (incl. ../../runtime/loop/monitor_emit.js for the derived phase feed).
 * Imported by: mcp/server.ts (handler map).
 */

import { z } from 'zod';

import { loadActiveV2Cartridges } from '../../runtime/bootstrap.js';
import { readFsmStateFile } from '../../runtime/fsm_state.js';
import { resolveMcpSessionId } from '../../runtime/hooks/session_id.js';
import { emitMonitorEvent } from '../../runtime/loop/monitor_emit.js';
import { writePhaseLedger } from '../../runtime/phase_ledger.js';
import { readActiveTask } from '../../runtime/session_state.js';
import { REQUIRED_PHASES, appendPhase, isComplete } from '../../runtime/workflow_phases.js';

/** E4 — the FSM stages that PRECEDE `code`; logging a CODE phase while the task FSM is in one of these is the
 *  self-report hole (phases logged without the upstream gates having passed). */
const PRE_CODE_STAGES = new Set(['scope', 'plan', 'author']);

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
  // scope-4 (§4): a headless ralph lap runs hooks-off (OPENSQUID_SUBAGENT), so the AP.1 mirror never writes
  // active-task.json — resolve the driven item from OPENSQUID_ITEM_ID so a lap can log its 7 CODE phases (the
  // ledger the commit gate requires). id === taskId === the wg id, so these phases key identically to the gate's
  // isComplete(phases, active.id) check. Interactively OPENSQUID_ITEM_ID is unset → pure active-task.json read.
  const active = await readActiveTask(sessionId, process.env.OPENSQUID_ITEM_ID);
  if (active === null) {
    throw new Error(
      'log_phase: no active task (active-task.json absent). Create a task and set it in_progress first (rule #1).',
    );
  }
  // E4 (docs/design/v2-enforcement-implementation.md) — STAGE-COUPLE the ledger: when a v2 discipline pack is
  // active, the 7 CODE phases may only be logged once the TASK's FSM has reached `code` (SCOPE→PLAN→AUTHOR
  // passed). REJECT a positively pre-code stage (the self-report hole). FAIL-OPEN when the per-task FSM is
  // absent/unreadable (the observed actor may not have run — the commit gate (E0) is the hard backstop) or no
  // v2 pack is active (v1 unchanged).
  let preCodeStage: string | null = null;
  try {
    const v2pack = (await loadActiveV2Cartridges(sessionId)).find(
      (c) => c.compiled.fsm !== undefined,
    )?.pack.name;
    if (v2pack !== undefined) {
      const fsm = await readFsmStateFile(sessionId, v2pack, active.id);
      if (fsm !== null && PRE_CODE_STAGES.has(fsm.state)) preCodeStage = fsm.state;
    }
  } catch {
    /* fail-open: an FSM/cartridge read error must never brick phase logging */
  }
  if (preCodeStage !== null) {
    throw new Error(
      `log_phase: the task FSM for "${active.id}" is at "${preCodeStage}", not the CODE stage — ` +
        `complete SCOPE→PLAN→AUTHOR before logging the 7 CODE phases (E4 stage coupling).`,
    );
  }
  // (a) durable phase ledger — TS-owned filesystem YAML (retire-Rust: was
  // engine.taskLogPhase; same `~/.opensquid/phase_ledger/<task>/<phase>.yaml`).
  await writePhaseLedger(active.id, args.phase, args.note);
  // (b) gate-readable session state
  const state = await appendPhase(sessionId, active.id, args.phase);
  const complete = isComplete(state, active.id);
  // scope-1 (T-deterministic-phase-monitor) — DETERMINISTIC monitor feed: the ENFORCED log_phase write DRIVES the
  // wg-keyed phase event, so CODE's 7 phases always show on loop-status / --watch WITHOUT the agent calling the
  // discretionary set_loop_phase. Keyed by active.id (= OPENSQUID_ITEM_ID = the wg id, :73) — identical to the
  // gate's isComplete key and to set_loop_phase's. log_phase fires ONCE per phase at COMPLETION (it is called on
  // leave), so the derived event is phase_leave (done ✓) — PLAN §5.1; a mid-phase running (⟳) marker has no cheap
  // start-signal and stays the OPTIONAL set_loop_phase supplement. Placed AFTER the E4 guard (:96-101), so a
  // REJECTED pre-code phase (which throws before the ledger writes) emits NOTHING. FAIL-OPEN by construction:
  // emitMonitorEvent swallows any store fault (monitor_emit.ts:21-30), so a monitor hiccup NEVER breaks the
  // load-bearing ledger write (identical posture to set_loop_phase.ts:88, loop_stage.ts:128).
  await emitMonitorEvent({
    wgId: active.id,
    kind: 'phase_leave',
    phase: args.phase,
    index: REQUIRED_PHASES.indexOf(args.phase) + 1, // 1-based position in the canonical 7-phase set
    total: REQUIRED_PHASES.length, // 7
    lifecycle: 'done',
    atMs: Date.now(),
  });
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
