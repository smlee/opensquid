/**
 * GUARD.1 — the Progress-floor guardrail as an EFSM (T-fsm-actor-runtime §GUARD.1).
 *
 * The substrate's NON-COMPOSABLE floor: every pack's loop runs under it. It is an
 * extended FSM (counter automaton) over the tool-call stream — three counters that
 * escalate to a gate Action when a loop degenerates:
 *
 *   exact_failure (same tool + identical args, failed)  warn@2  block@5
 *   same_tool_failure (same tool, failed, any args)      warn@3  halt@8
 *   idempotent_no_progress (read-only, same result)      warn@2  block@5
 *
 * Thresholds borrowed verbatim from Hermes `tool_guardrails.py` (the proven values);
 * the NAMES + the single-`observe` EFSM shape are opensquid's. Hermes splits the logic
 * across before_call/after_call; we collapse it to one `observe(call) → Action` and
 * resolve overlaps by SEVERITY-MAX (halt > block > warn > pass) — the principled reading
 * of multiple thresholds tripping at once.
 *
 * Reset semantics (from Hermes): a FAILURE bumps exact[sig] + same_tool[tool] and CLEARS
 * no_progress[sig] (a failing read is no longer "no progress, it's a failure); a passing or
 * progressing call resets NOTHING prematurely — the counters persist for the turn so a
 * single success can't mask an established loop. The Action is consumed by the loop driver
 * (LOOP.1) via the completion connector; `block`/`halt` carry no message here (KERN.1 owns
 * the failure-typed instruction store) — this EFSM only decides the SEVERITY.
 */
import type { Action } from '../gate/kernel.js';

/** A normalized tool-call observation (the loop adapts the raw tool_ledger into this). */
export interface ToolObservation {
  tool: string; // tool name (the `same_tool` key)
  argsHash: string; // stable hash of the args (the `exact`/`no_progress` signature key)
  failed: boolean; // did the call fail?
  idempotentSameResult: boolean; // a read-only call that returned the same result as before
}

// Hermes thresholds (tool_guardrails.py) — borrowed values, opensquid names.
const EXACT_WARN = 2;
const EXACT_BLOCK = 5;
const SAME_TOOL_WARN = 3;
const SAME_TOOL_HALT = 8;
const NO_PROGRESS_WARN = 2;
const NO_PROGRESS_BLOCK = 5;

const inc = (m: Map<string, number>, k: string): number => {
  const n = (m.get(k) ?? 0) + 1;
  m.set(k, n);
  return n;
};

export class ProgressFloor {
  private readonly exact = new Map<string, number>(); // argsHash → consecutive exact failures
  private readonly sameTool = new Map<string, number>(); // tool → failures this turn
  private readonly noProgress = new Map<string, number>(); // argsHash → idempotent repeats

  /**
   * Observe one tool call and return the floor's gate Action. SEVERITY-MAX: when several
   * thresholds trip, the most severe wins (halt > block > warn > pass).
   */
  observe(call: ToolObservation): Action {
    if (call.failed) {
      const exactN = inc(this.exact, call.argsHash);
      this.noProgress.delete(call.argsHash); // a failure is not "no progress" (Hermes pops it)
      const sameN = inc(this.sameTool, call.tool);
      if (sameN >= SAME_TOOL_HALT) return 'halt'; // most severe
      if (exactN >= EXACT_BLOCK) return 'block';
      if (exactN >= EXACT_WARN || sameN >= SAME_TOOL_WARN) return 'warn';
      return 'pass';
    }
    if (call.idempotentSameResult) {
      const k = inc(this.noProgress, call.argsHash);
      if (k >= NO_PROGRESS_BLOCK) return 'block';
      if (k >= NO_PROGRESS_WARN) return 'warn';
      return 'pass';
    }
    return 'pass'; // a progressing call: no escalation, and counters are NOT reset (no premature mask)
  }

  /** Inspect the current counters (observability / tests) — a read-only snapshot. */
  counts(): { exact: number; sameTool: number; noProgress: number } {
    const max = (m: Map<string, number>): number => Math.max(0, ...m.values());
    return {
      exact: max(this.exact),
      sameTool: max(this.sameTool),
      noProgress: max(this.noProgress),
    };
  }
}
