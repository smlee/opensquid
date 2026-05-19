/**
 * Tick driver — pure data layer for the `unloads_when` evaluator.
 *
 * The runtime maintains one `TickState` per active skill. As Events flow
 * through the dispatcher, `advanceTick` updates that state so the evaluator
 * (`unload_conditions.ts`) can answer "should this skill unload?" without
 * the dispatcher having to bake event-shape knowledge into every check.
 *
 * Authoritative source: `docs/opensquid-real-design.md` §"Skill format" +
 * memory `feedback_workflow_cycle` (turn = UserPromptSubmit cycle).
 *
 * Turn definition — pinned: a "turn" is ONE UserPromptSubmit event. Tool
 * calls inside that turn do NOT increment the counter. This matches the
 * 7-phase workflow loop (pre-research → learn → code → test → audit →
 * post-research → fix), where the boundary that matters for "idle" is
 * "did the user say anything new" — not "did the agent run a tool."
 *
 * State transitions per Event kind:
 *
 *   prompt_submit  → turnsSinceActivation += 1
 *   stop           → taskCompleted = true
 *   session_end    → sessionEnded = true
 *   tool_call      → no-op (tool calls are sub-events of a turn)
 *
 * `resetTick` puts a fresh state on the wire when a skill (re)activates —
 * the counters apply from that point forward, not from session start.
 *
 * Pure data, no I/O. Returns a NEW object on each `advanceTick` call so the
 * dispatcher can keep prior snapshots around if it wants (e.g. for diagnostic
 * dumps). The evaluator reads the latest snapshot.
 *
 * Imports from: ./types, ./unload_conditions.
 * Imported by: src/runtime/index.ts; (eventually) the dispatcher.
 */

import type { Event } from './types.js';
import type { TickState } from './unload_conditions.js';

// ---------------------------------------------------------------------------
// createTick — initial state when a skill first activates.
// ---------------------------------------------------------------------------

export function createTick(): TickState {
  return { turnsSinceActivation: 0, taskCompleted: false, sessionEnded: false };
}

// ---------------------------------------------------------------------------
// advanceTick — apply one event to a tick snapshot.
//
// Returns a new TickState (input is treated as immutable). Tool calls are
// no-ops because the "turn" boundary is the UserPromptSubmit cycle, not the
// tool-call cycle. See module header.
// ---------------------------------------------------------------------------

export function advanceTick(state: Readonly<TickState>, event: Event): TickState {
  switch (event.kind) {
    case 'prompt_submit':
      return { ...state, turnsSinceActivation: state.turnsSinceActivation + 1 };
    case 'stop':
      return { ...state, taskCompleted: true };
    case 'session_end':
      return { ...state, sessionEnded: true };
    case 'tool_call':
      // Tool calls happen inside a turn — by design, NOT a turn boundary.
      // See module header.
      return state;
  }
}

// ---------------------------------------------------------------------------
// resetTick — when a skill (re)activates, the idle counter restarts from
// zero. taskCompleted/sessionEnded reset too because the new activation lives
// in a new task scope.
// ---------------------------------------------------------------------------

export function resetTick(): TickState {
  return createTick();
}
