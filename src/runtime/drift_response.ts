/**
 * Drift response dispatcher: maps (Verdict, DriftPolicy) → RuntimeAction.
 *
 * Sits between the rule evaluator (which produces `Verdict`s) and the hook
 * layer (which executes `RuntimeAction`s). A rule decides what happened;
 * the pack-declared `drift_response` policy decides what to do about it.
 * Phase 1 ships the four policies in `DriftPolicy`; `auto_correct` and
 * `escalate` are deferred (see `runtime/types.ts` notes).
 *
 * Dispatch shape is intentionally a `Record<DriftPolicy, ...>` lookup table,
 * NOT an if/else (or switch) cascade — constraint from the design doc
 * §"Drift response policies" + Task 1.6 acceptance criteria. The lookup
 * lets a future Phase widen the policy set by appending one map entry,
 * with TS's exhaustiveness check on `DriftPolicy` guaranteeing every variant
 * has a handler (the `Record<DriftPolicy, ...>` type errors on omission).
 *
 * Unknown-policy fail-safe (constraint C10 — no silent fail-open): if the
 * caller hands us a policy string that isn't in `DISPATCH` (e.g. a typo in
 * pack YAML that slipped past schema validation, or a future variant the
 * dispatcher doesn't recognize), we degrade to `notify_pause` with severity
 * `'critical'` rather than silently picking a "safe default" policy. The
 * cast at the call site (`policy as DriftPolicy`) is the only path that
 * reaches this branch; the TS layer above prevents legitimate callers from
 * hitting it.
 *
 * Imports from: ./types.js.
 * Imported by: src/runtime/index.ts (re-export), runtime/hooks/ (Task 1.7).
 */

import type { DriftPolicy, RuntimeAction, Verdict } from './types.js';

// ---------------------------------------------------------------------------
// DISPATCH — the lookup table. One entry per `DriftPolicy` variant; TS's
// `Record<DriftPolicy, ...>` enforces exhaustiveness at compile time.
//
// Each handler is a pure function of the verdict alone (no I/O, no state).
// `notify_and_pause` defaults to severity `'error'`; severity `'critical'`
// is reserved for the unknown-policy fail-safe so the two cases stay
// distinguishable downstream.
// ---------------------------------------------------------------------------

const DISPATCH: Record<DriftPolicy, (v: Verdict) => RuntimeAction> = {
  block_tool: (v) => ({ kind: 'block_tool', message: v.message }),
  warn: (v) => ({ kind: 'warn', message: v.message }),
  full_stop_and_redo: (v) => ({ kind: 'halt', reason: v.message }),
  notify_and_pause: (v) => ({
    kind: 'notify_pause',
    reason: v.message,
    severity: 'error',
  }),
};

export function applyDriftResponse(verdict: Verdict, policy: DriftPolicy): RuntimeAction {
  const fn = DISPATCH[policy];
  if (!fn) {
    // C10 fail-safe: unknown policy ⇒ notify_pause + 'critical'.
    // The unknown string is interpolated raw so audit trails capture
    // exactly what came in (helps debug the pack-author typo case).
    return {
      kind: 'notify_pause',
      reason: `Unknown policy "${String(policy)}"`,
      severity: 'critical',
    };
  }
  return fn(verdict);
}
