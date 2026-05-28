/**
 * Drift response dispatcher: maps (Verdict, DriftPolicy) → RuntimeAction.
 *
 * Sits between the rule evaluator (which produces `Verdict`s) and the hook
 * layer (which executes `RuntimeAction`s). A rule decides what happened;
 * the pack-declared `drift_response` policy decides what to do about it.
 * All six `DriftPolicy` variants are wired here (AUTO.4 finished the two
 * previously-deferred policies — `auto_correct` and `escalate`).
 *
 * Dispatch shape is intentionally a `Record<DriftPolicy, ...>` lookup table,
 * NOT an if/else (or switch) cascade — constraint from the design doc
 * §"Drift response policies" + Task 1.6 acceptance criteria. The lookup
 * lets a future Phase widen the policy set by appending one map entry,
 * with TS's exhaustiveness check on `DriftPolicy` guaranteeing every variant
 * has a handler (the `Record<DriftPolicy, ...>` type errors on omission).
 *
 * `auto_correct` semantics (AUTO.4): produces an action descriptor
 * `{kind: 'auto_correct', correctiveSkill, verdict}`. The dispatcher
 * resolves the corrective skill from the pack's
 * `drift_response.corrective_skills[ruleId]` map. If no corrective skill is
 * declared for the rule, the dispatcher degrades to `notify_pause` with
 * severity 'critical' and a reason naming the missing entry — no silent
 * fail-open (constraint C10). The runtime layer (`runtime/auto_correct.ts`)
 * picks up the descriptor, runs the capability gate, invokes the corrective
 * skill via the evaluator, and re-evaluates the original rule.
 *
 * `escalate` semantics (AUTO.4): produces an action descriptor
 * `{kind: 'escalate', reroutedSeverity: 'critical', verdict}`. The runtime
 * layer (`runtime/escalate.ts`) does the side-effects — applies the
 * RateLimiter (paging-fatigue prevention) then multicasts via
 * NotificationRouter using the critical-tier channel list.
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
 * Imported by: src/runtime/index.ts (re-export), runtime/hooks/ (Task 1.7),
 * runtime/auto_correct.ts + runtime/escalate.ts (action-descriptor consumers).
 */

import type { DriftPolicy, MessageVerdict, RuntimeAction } from './types.js';

/**
 * T-ASC ASC.3: drift_response only processes message-bearing verdicts.
 * Directive-level verdicts flow through a separate dispatcher path
 * (DispatchResult.directives aggregation, surfaced via UserPromptSubmit
 * envelope) and never reach applyDriftResponse.
 */
type Verdict = MessageVerdict;

// ---------------------------------------------------------------------------
// DISPATCH — the lookup table. One entry per `DriftPolicy` variant; TS's
// `Record<DriftPolicy, ...>` enforces exhaustiveness at compile time.
//
// Each handler is a pure function of the verdict + dispatch context (no I/O,
// no async). For `auto_correct` the dispatcher only resolves the corrective
// skill name from the per-rule map; actually running the skill + re-evaluating
// the rule is the upper-layer `runtime/auto_correct.ts` concern (it needs
// the capability gate + evaluator, which the dispatcher must not depend on).
//
// `notify_and_pause` defaults to severity `'error'`; severity `'critical'`
// is reserved for the unknown-policy fail-safe + the missing-corrective-skill
// fail-safe + the escalate path's reroutedSeverity, so the cases stay
// distinguishable downstream.
// ---------------------------------------------------------------------------

/**
 * Per-call dispatch context. Only `auto_correct` needs the corrective-skill
 * map; the other handlers ignore it. Field is optional so callers that only
 * use the 4 stable policies don't have to construct an empty record.
 */
export interface DriftDispatchCtx {
  correctiveSkills?: Record<string, string>;
}

const DISPATCH: Record<DriftPolicy, (v: Verdict, ctx: DriftDispatchCtx) => RuntimeAction> = {
  block_tool: (v) => ({ kind: 'block_tool', message: v.message }),
  warn: (v) => ({ kind: 'warn', message: v.message }),
  full_stop_and_redo: (v) => ({ kind: 'halt', reason: v.message }),
  notify_and_pause: (v) => ({
    kind: 'notify_pause',
    reason: v.message,
    severity: 'error',
  }),
  auto_correct: (v, ctx) => {
    // C10: corrective skill MUST be declared for the rule, else fail-loud.
    // We need a ruleId to resolve from `corrective_skills`; without one the
    // map is unusable and we degrade rather than guessing.
    const ruleId = v.ruleId;
    const correctiveSkill = ruleId !== undefined ? ctx.correctiveSkills?.[ruleId] : undefined;
    if (correctiveSkill === undefined || correctiveSkill === '') {
      return {
        kind: 'notify_pause',
        reason:
          ruleId === undefined
            ? 'auto_correct policy requires a verdict with `ruleId`; none provided'
            : `auto_correct policy for rule "${ruleId}" missing entry in corrective_skills`,
        severity: 'critical',
      };
    }
    return { kind: 'auto_correct', correctiveSkill, verdict: v };
  },
  escalate: (v) => ({ kind: 'escalate', reroutedSeverity: 'critical', verdict: v }),
};

export function applyDriftResponse(
  verdict: Verdict,
  policy: DriftPolicy,
  ctx: DriftDispatchCtx = {},
): RuntimeAction {
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
  return fn(verdict, ctx);
}
