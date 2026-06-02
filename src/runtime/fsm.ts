/**
 * T-PACK-FSM-STANDARDIZATION slice A — the generic total-transition FSM engine.
 *
 * The capstone thesis is that a pack's lifecycle is an EXPLICIT TOTAL-TRANSITION
 * FSM. Today the only "FSM" (`chain_state.ts`) is a single global stage tracker
 * whose `transitionChainStage` accepts ANY target with no legality matrix — it
 * is NOT total and cannot loop back. This module is the generic engine that
 * replaces that: a pure, pack-declarable FSM with validated transitions.
 *
 * Two pure pieces:
 *   - `validateFsm(fsm)` — load-time checks: `initial` and every transition's
 *     `from`/`to` reference a declared state; no transition targets an
 *     undefined state. Returns the list of errors (empty = valid). This is what
 *     makes the machine TOTAL-by-construction: every reachable transition lands
 *     on a real state, and the runner defines an outcome for EVERY (state,event)
 *     pair (a matching transition, else an explicit stay).
 *   - `step(fsm, current, event, evalWhen?)` — the transition function. Total:
 *     returns a defined next-state for every input. No I/O; the optional
 *     `when` guard is evaluated through an injected `evalWhen` (the caller wires
 *     the expression engine) so this module stays pure + testable.
 *
 * Unlike `chain_state`, transitions here are DECLARED data, support `*` (any
 * source) and a `when` guard, and can LOOP BACK (e.g. `researching --guess-->
 * researching`) — the edge the scope guess-prevention gate (slice C) needs.
 *
 * Imports: zod only. Imported by: slice A2 (runtime integration), slice C
 * (scope FSM), tests.
 */
import { z } from 'zod';

/** A wildcard `from` matching any current state. */
export const ANY_STATE = '*' as const;

export const Transition = z
  .object({
    /** Source state name, or `*` to match any current state. */
    from: z.string().min(1),
    /** Event name that fires this transition. */
    on: z.string().min(1),
    /** Target state — MUST be a declared state (validateFsm enforces). */
    to: z.string().min(1),
    /** Optional `if:`-expression guard; evaluated via the injected evalWhen. */
    when: z.string().min(1).optional(),
  })
  .strict();
export type Transition = z.infer<typeof Transition>;

export const Fsm = z
  .object({
    initial: z.string().min(1),
    states: z.array(z.string().min(1)).min(1),
    transitions: z.array(Transition).default([]),
  })
  .strict();
export type Fsm = z.infer<typeof Fsm>;

/**
 * Load-time validation. Returns a (possibly empty) list of human-readable
 * errors. The machine is TOTAL by construction once these pass: the runner
 * defines an outcome for every (state, event), and every declared transition
 * lands on a real state.
 */
export function validateFsm(fsm: Fsm): string[] {
  const errors: string[] = [];
  const states = new Set(fsm.states);

  if (!states.has(fsm.initial)) {
    errors.push(`initial state "${fsm.initial}" is not in states [${fsm.states.join(', ')}]`);
  }
  fsm.transitions.forEach((t, i) => {
    if (t.from !== ANY_STATE && !states.has(t.from)) {
      errors.push(`transition[${String(i)}] from "${t.from}" is not a declared state`);
    }
    if (!states.has(t.to)) {
      errors.push(`transition[${String(i)}] to "${t.to}" is not a declared state`);
    }
  });
  return errors;
}

export interface StepResult {
  /** The next state (== current when no transition matched — total/explicit stay). */
  next: string;
  /** True iff a transition actually moved to a different state. */
  transitioned: boolean;
  /** The id (index) of the transition taken, or null for the stay default. */
  via: number | null;
}

/**
 * The transition function — TOTAL: returns a defined next-state for every
 * (current, event). Finds the FIRST transition whose `from` matches (exact or
 * `*`), whose `on` equals `event`, and whose `when` guard (if any) holds.
 * No match → stay in `current` (the explicit default — no implicit/undefined
 * state). `evalWhen` evaluates a guard expression; omitted → guards are treated
 * as satisfied (caller opted out of guard evaluation).
 */
export function step(
  fsm: Fsm,
  current: string,
  event: string,
  evalWhen?: (expr: string) => boolean,
): StepResult {
  for (let i = 0; i < fsm.transitions.length; i++) {
    const t = fsm.transitions[i]!;
    if ((t.from === current || t.from === ANY_STATE) && t.on === event) {
      if (t.when === undefined || evalWhen === undefined || evalWhen(t.when)) {
        return { next: t.to, transitioned: t.to !== current, via: i };
      }
    }
  }
  return { next: current, transitioned: false, via: null };
}
