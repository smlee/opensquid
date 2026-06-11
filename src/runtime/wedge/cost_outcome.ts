/**
 * Stage 2 wedge gate applied to cost-tier outcomes (AUTO.7).
 *
 * Authoritative source: the automation planning notes [not retained — this header is the authority] §"Task AUTO.7" + Stage 2
 * pattern from `./promote.ts` + `./schedule_outcome.ts` + memory
 * `project_opensquid_wedge_gate_two_stages`.
 *
 * Pure decision function over `CostOutcomeSignal[]` that recommends
 * `keep | upgrade | downgrade` for a tier-routed job. Inputs come
 * exclusively from USER signals captured upstream:
 *
 *   - `userRedoCount`  — count of `full_stop_and_redo` invocations on
 *                        runs dispatched at this tier (AUTO.4 drift).
 *   - `manualOverride` — true when the user invoked CLI override to re-run
 *                        the job at a different tier.
 *
 * Result-kind / latency / vendor errors are NOT decision inputs at this
 * layer — only the user signal moves the needle. This is the wedge gate's
 * anti-self-grading invariant: no LLM call, no self-graded verdict,
 * external validation only.
 *
 * Eviction-immunity note: a tier recommendation is advisory. The user
 * decides whether to act — pencil-whipping `manual_override` is the user's
 * prerogative (per spec risk callout).
 *
 * Why a separate file (not extending promote.ts): `promote.ts` evaluates
 * ONE lesson over N applications. Cost outcomes evaluate ONE tier across N
 * scheduled runs — different signal shape and recommendation space. Same
 * precedent as `schedule_outcome.ts`.
 *
 * Anti-self-grading invariant: this module MUST NOT call an LLM primitive.
 * The audit-grep that anchors the wedge moat covers this file alongside
 * `promote.ts` + `schedule_outcome.ts`.
 *
 * Imports from: nothing. Imported by: src/runtime/wedge/index.ts.
 */

import type { CostTier } from '../../models/cost_router.js';

/**
 * One fire's worth of user-signal evidence. `userRedoCount` stays a count
 * (not a boolean) so future heuristics can sum redoes across many short
 * runs. `manualOverride` is the stronger signal — the user deliberately
 * re-ran at a different tier.
 */
export interface CostEvidence {
  runId: string;
  userRedoCount: number;
  manualOverride: boolean;
}

/**
 * One (schedule, tier, alias) triplet's evidence accumulated over N runs.
 * `verdict` is the CURRENT persisted status (or `pending_review` fresh);
 * the evaluator returns a recommended next status separately so the audit
 * log can record (current, recommended, applied?) without policy mixed in.
 */
export interface CostOutcomeSignal {
  scheduleId: string;
  tier: CostTier;
  alias: string;
  verdict: 'adequate' | 'inadequate' | 'pending_review';
  evidence: CostEvidence[];
}

/**
 * Pack-declared knobs (defaulted at runtime).
 *
 * `windowN`            — minimum evidence-count before a recommendation can
 *                        be issued.
 * `minRedoUpgrade`     — count of user-redoes that triggers `upgrade`.
 *                        Default 3 (matches schedule_outcome's
 *                        `minRedoRetire`).
 * `minOverrideUpgrade` — manual-override count that triggers `upgrade`.
 *                        Default 1 (manual override is a deliberate
 *                        signal; one is enough).
 */
export interface TierAdequacyThreshold {
  windowN: number;
  minRedoUpgrade: number;
  minOverrideUpgrade: number;
}

export const DEFAULT_TIER_ADEQUACY_THRESHOLD: TierAdequacyThreshold = {
  windowN: 5,
  minRedoUpgrade: 3,
  minOverrideUpgrade: 1,
};

/**
 * Evaluator output.
 *
 * `recommend`     — `upgrade`   tier inadequate (user redid / overrode).
 *                   `downgrade` tier over-provisioned (zero redoes + zero
 *                               overrides + evidence >= windowN + tier
 *                               isn't `cheap` — cheap has no cheaper
 *                               tier).
 *                   `keep`      insufficient evidence OR adequate but not
 *                               over-provisioned.
 * `evidenceCount` — total evidence rows (filtered to first-seen tier).
 */
export interface TierAdequacyVerdict {
  recommend: 'keep' | 'upgrade' | 'downgrade';
  evidenceCount: number;
}

/**
 * Pure decision function. Precedence (locked per spec §"learn"):
 *
 *   1. `evidenceCount < windowN` → `keep` (sample too small).
 *   2. `totalRedoCount >= minRedoUpgrade` OR
 *      `totalOverrideCount >= minOverrideUpgrade` → `upgrade`.
 *   3. zero redoes + zero overrides + evidenceCount >= windowN +
 *      tier !== 'cheap' → `downgrade`.
 *   4. otherwise → `keep`.
 *
 * All signals must agree on `tier` — the evaluator is per-tier. If they
 * disagree, the function treats first-seen tier as authoritative and
 * ignores divergent rows (audit log surfaces the mismatch upstream — this
 * function is pure).
 */
export function evaluateTierAdequacy(
  signals: CostOutcomeSignal[],
  threshold: TierAdequacyThreshold = DEFAULT_TIER_ADEQUACY_THRESHOLD,
): TierAdequacyVerdict {
  let evidenceCount = 0;
  let totalRedoCount = 0;
  let totalOverrideCount = 0;
  let tier: CostTier | undefined;

  for (const signal of signals) {
    tier ??= signal.tier;
    if (signal.tier !== tier) continue;
    for (const ev of signal.evidence) {
      evidenceCount++;
      totalRedoCount += Math.max(0, ev.userRedoCount);
      if (ev.manualOverride) totalOverrideCount++;
    }
  }

  if (evidenceCount < threshold.windowN) {
    return { recommend: 'keep', evidenceCount };
  }

  if (
    totalRedoCount >= threshold.minRedoUpgrade ||
    totalOverrideCount >= threshold.minOverrideUpgrade
  ) {
    return { recommend: 'upgrade', evidenceCount };
  }

  if (totalRedoCount === 0 && totalOverrideCount === 0 && tier !== 'cheap') {
    return { recommend: 'downgrade', evidenceCount };
  }

  return { recommend: 'keep', evidenceCount };
}
