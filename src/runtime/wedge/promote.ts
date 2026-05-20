/**
 * Stage 2 promotion gate — outcome-validated, no LLM self-grading.
 *
 * Authoritative source: `docs/opensquid-real-design.md` §"Two-stage wedge gate"
 * Stage 2 + §"Strategic moat" + `feedback_user_authored_lessons_immune` +
 * `project_opensquid_wedge_gate_two_stages` (memory).
 *
 * The wedge-gate moat is anchored here: every other LLM memory system on the
 * market (Mem0, Letta, Zep, Anthropic Auto-Dream, claude-auto-memory)
 * self-grades — the model decides whether its own lessons are good. Open-
 * squid's promotion decision is PURELY EXTERNAL. The only signals that move
 * a lesson from "pending" → "applied skill mutation" are:
 *
 *   1. User explicit confirm (short-circuit promote).
 *   2. Both `applied >= threshold.minApplications`
 *      AND `(passRateAfter - passRateBefore) >= threshold.minImprovement`.
 *
 * The audit-grep for this module checks for any LLM-primitive call name and
 * MUST return empty. If a future change adds an LLM call here, the audit
 * fails and the moat is broken. (See the matching test + the
 * phase-7-wedge-gate.md spec for the exact regex pattern.)
 *
 * `shouldPromote` is intentionally pure (no I/O, no clock, no random) so the
 * caller can drive it from any signal source (verdict catalog, hook
 * counters, end-of-automation cycle). The caller is responsible for:
 *
 *   - Collecting `verdictPassRateBefore` (e.g. mean over the N events
 *     immediately preceding lesson capture).
 *   - Collecting `verdictPassRateAfter` (mean over the N events after the
 *     lesson started getting applied).
 *   - Counting `applied` (how many times the lesson was consulted).
 *
 * Phase 7's deliverable is the pure decision function; the signal-collection
 * pipeline lands in Phase 8 (mutation + tracking).
 *
 * Imports from: nothing.
 * Imported by: src/runtime/wedge/index.ts.
 */

// ---------------------------------------------------------------------------
// OutcomeSignal — input to `shouldPromote`.
//
// `lessonId`             — opaque identifier (filename component).
// `applied`              — non-negative count of times the lesson was
//                          consulted by the agent. Floor-clamped at 0 by
//                          the caller.
// `verdictPassRateBefore` — pre-lesson pass rate in [0, 1].
// `verdictPassRateAfter`  — post-lesson pass rate in [0, 1].
// `userExplicitConfirm`  — set true ONLY when the user has explicitly said
//                          "yes, promote this lesson" via the cycle UI.
//                          Short-circuits the outcome metrics check.
// ---------------------------------------------------------------------------

export interface OutcomeSignal {
  lessonId: string;
  applied: number;
  verdictPassRateBefore: number;
  verdictPassRateAfter: number;
  userExplicitConfirm: boolean;
}

// ---------------------------------------------------------------------------
// PromotionThreshold — pack-declared thresholds.
//
// `minApplications` — minimum count of applications before outcome metrics
//                     are considered. Below this, sample size is too small
//                     to trust the delta. Default per design doc: 5.
// `minImprovement`  — minimum delta in pass rate (after - before) to qualify
//                     as "the lesson is helping." Negative deltas never
//                     promote. Default per design doc: 0.1 (10 percentage
//                     points).
// ---------------------------------------------------------------------------

export interface PromotionThreshold {
  minApplications: number;
  minImprovement: number;
}

// ---------------------------------------------------------------------------
// shouldPromote — pure decision function.
//
// Returns true when the lesson should be promoted into the skill mutation
// path (Task 7.4). Returns false in all other cases.
//
// Anti-self-grading invariant: this function MUST NOT invoke any LLM
// primitive (classifier, subagent, model-aliased call, etc.). The decision
// is fully determined by `signal` + `threshold` inputs.
// ---------------------------------------------------------------------------

export function shouldPromote(signal: OutcomeSignal, threshold: PromotionThreshold): boolean {
  // User-explicit-confirm short-circuit: user authorship is eviction-immune
  // (per `feedback_user_authored_lessons_immune`) AND auto-promotes.
  if (signal.userExplicitConfirm) return true;

  // Outcome metrics gate: both thresholds must be cleared.
  if (signal.applied < threshold.minApplications) return false;
  const improvement = signal.verdictPassRateAfter - signal.verdictPassRateBefore;
  return improvement >= threshold.minImprovement;
}
