/**
 * Tests for `shouldPromote` (Task 7.3).
 *
 * Acceptance per phase-7-wedge-gate.md §"Task 7.3":
 *  - No LLM self-grading anywhere in promotion path (audited via rg).
 *  - User explicit confirm overrides outcome metrics.
 *  - Both thresholds enforced (applications + improvement).
 *  - ≥ 4 tests.
 */

import { describe, expect, it } from 'vitest';

import { shouldPromote, type OutcomeSignal, type PromotionThreshold } from './promote.js';

const T: PromotionThreshold = { minApplications: 5, minImprovement: 0.1 };

function signal(overrides: Partial<OutcomeSignal> = {}): OutcomeSignal {
  return {
    lessonId: 'l-1',
    applied: 10,
    verdictPassRateBefore: 0.5,
    verdictPassRateAfter: 0.8,
    userExplicitConfirm: false,
    ...overrides,
  };
}

describe('shouldPromote', () => {
  it('promotes when both thresholds are cleared', () => {
    // applied 10 (>= 5) AND improvement 0.3 (>= 0.1).
    expect(shouldPromote(signal(), T)).toBe(true);
  });

  it('does not promote when improvement is below the threshold', () => {
    expect(
      shouldPromote(signal({ verdictPassRateBefore: 0.5, verdictPassRateAfter: 0.55 }), T),
    ).toBe(false);
  });

  it('does not promote when applications are insufficient', () => {
    expect(shouldPromote(signal({ applied: 2 }), T)).toBe(false);
  });

  it('user explicit confirm short-circuits the metrics gate', () => {
    // applied = 0, improvement = 0 — would normally fail. user confirm wins.
    expect(
      shouldPromote(
        signal({
          applied: 0,
          verdictPassRateBefore: 0.9,
          verdictPassRateAfter: 0.1,
          userExplicitConfirm: true,
        }),
        T,
      ),
    ).toBe(true);
  });

  it('does not promote on a negative improvement (regression)', () => {
    expect(
      shouldPromote(signal({ verdictPassRateBefore: 0.8, verdictPassRateAfter: 0.5 }), T),
    ).toBe(false);
  });

  it('exactly-at-threshold counts as promote (>=, not >)', () => {
    // applied exactly minApplications, improvement exactly the threshold.
    // We use float-safe values to avoid floating-point trap: 0.6 - 0.5 is
    // not exactly 0.1 in IEEE 754, but (0.75 - 0.5) is exactly 0.25.
    const thresh: PromotionThreshold = { minApplications: 5, minImprovement: 0.25 };
    expect(
      shouldPromote(
        signal({
          applied: 5,
          verdictPassRateBefore: 0.5,
          verdictPassRateAfter: 0.75,
        }),
        thresh,
      ),
    ).toBe(true);
  });

  it('is a pure function — same inputs always yield the same output', () => {
    const s = signal();
    const a = shouldPromote(s, T);
    const b = shouldPromote(s, T);
    expect(a).toBe(b);
  });
});
