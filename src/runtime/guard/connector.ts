/**
 * GUARD.1 — the completion connector (T-fsm-actor-runtime §GUARD.1).
 *
 * A guardrail is a CONNECTOR: it binds the generic loop to an execution FSM and keeps
 * the loop from breaking until the work is genuinely complete. It enforces a two-part
 * completion contract:
 *
 *   LIVENESS — don't break the loop until the FSM reaches a terminal state AND the
 *              completion guard holds. An executor claiming "done" while its completion
 *              guard FAILS does NOT release the loop — the loop self-continues (the
 *              anti-self-grading guarantee: you cannot exit by asserting you are done).
 *
 *   SAFETY  — break the loop (→ WEDGE) if it has degenerated: the Progress floor returns
 *             `halt`. A degenerate loop must stop, not spin forever.
 *
 * This is the substrate side of "guardrails aid a loop from breaking until some execution
 * is complete." The verdict drives LOOP.1: `continue` (keep stepping the inner loop),
 * `release` (advance past the executor state), or `break` (park the actor as wedged).
 */
import type { Action } from '../gate/kernel.js';

export type LoopVerdict =
  | { kind: 'continue' } // liveness: not complete yet — keep going (incl. claims-done-but-guard-fails)
  | { kind: 'release' } // terminal reached + completion guard held — advance
  | { kind: 'break'; reason: string }; // safety: degenerate — park as wedge

export interface CompletionInput {
  /** has the executor's completion guard held? (anti-self-grading: claims-done is not enough) */
  completionGuardHeld: boolean;
  /** the Progress-floor action for the latest tool call (GUARD.1 EFSM). */
  floorAction: Action;
}

/**
 * Evaluate the completion contract for one inner-loop tick. SAFETY is checked first (a
 * degenerate loop breaks even if it looks done); then LIVENESS (release only when the
 * completion guard genuinely holds, else continue).
 */
export function evaluateCompletion(input: CompletionInput): LoopVerdict {
  if (input.floorAction === 'halt') {
    return { kind: 'break', reason: 'progress-floor-degenerate' }; // SAFETY: stop a degenerate loop
  }
  if (input.completionGuardHeld) {
    return { kind: 'release' }; // LIVENESS satisfied: the guard held → the work is genuinely complete
  }
  return { kind: 'continue' }; // not complete (incl. claims-done-but-guard-fails) → self-continue
}
