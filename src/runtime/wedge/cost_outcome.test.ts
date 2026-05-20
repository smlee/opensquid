/**
 * Tests for AUTO.7 Stage 2 tier-adequacy evaluator.
 *
 * Acceptance per docs/tasks/automation.md §"Task AUTO.7":
 *  - Pure decision function over user signals (no LLM call).
 *  - Sub-windowN evidence → keep.
 *  - user-redo count ≥ minRedoUpgrade → upgrade.
 *  - manual_override count ≥ minOverrideUpgrade → upgrade.
 *  - All-clean run ≥ windowN on a non-cheap tier → downgrade.
 *  - cheap tier never downgrades (no cheaper tier).
 *  - ≥ 4 tests.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TIER_ADEQUACY_THRESHOLD,
  evaluateTierAdequacy,
  type CostEvidence,
  type CostOutcomeSignal,
} from './cost_outcome.js';

function makeSignal(
  tier: CostOutcomeSignal['tier'],
  evidence: CostEvidence[],
  scheduleId = 'sched-1',
  alias = 'a-1',
): CostOutcomeSignal {
  return {
    scheduleId,
    tier,
    alias,
    verdict: 'pending_review',
    evidence,
  };
}

function ev(userRedoCount: number, manualOverride: boolean, runId = 'r-x'): CostEvidence {
  return { runId, userRedoCount, manualOverride };
}

describe('evaluateTierAdequacy — insufficient evidence', () => {
  it('returns keep when evidenceCount < windowN', () => {
    const signals = [makeSignal('cheap', [ev(1, false), ev(0, false)])];
    const verdict = evaluateTierAdequacy(signals);
    expect(verdict.recommend).toBe('keep');
    expect(verdict.evidenceCount).toBe(2);
  });

  it('returns keep on empty signals', () => {
    expect(evaluateTierAdequacy([])).toEqual({ recommend: 'keep', evidenceCount: 0 });
  });
});

describe('evaluateTierAdequacy — upgrade signals', () => {
  it('recommends upgrade when user redo count meets the threshold (3 of 5 runs)', () => {
    // Direct mapping of spec test fixture: "5 schedule runs with cost_tier: cheap;
    // user redid 3 of 5 → Stage 2 recommends upgrade to balanced".
    const signals = [
      makeSignal('cheap', [
        ev(1, false, 'r-1'),
        ev(1, false, 'r-2'),
        ev(1, false, 'r-3'),
        ev(0, false, 'r-4'),
        ev(0, false, 'r-5'),
      ]),
    ];
    const verdict = evaluateTierAdequacy(signals);
    expect(verdict.recommend).toBe('upgrade');
    expect(verdict.evidenceCount).toBe(5);
  });

  it('recommends upgrade when a single manual_override fires', () => {
    const signals = [
      makeSignal('balanced', [
        ev(0, false, 'r-1'),
        ev(0, false, 'r-2'),
        ev(0, false, 'r-3'),
        ev(0, false, 'r-4'),
        ev(0, true, 'r-5'),
      ]),
    ];
    expect(evaluateTierAdequacy(signals).recommend).toBe('upgrade');
  });

  it('sums redo counts across multiple signals (same tier)', () => {
    const signals = [
      makeSignal('cheap', [ev(1, false, 'r-1'), ev(1, false, 'r-2')], 's-1'),
      makeSignal('cheap', [ev(1, false, 'r-3'), ev(0, false, 'r-4'), ev(0, false, 'r-5')], 's-2'),
    ];
    expect(evaluateTierAdequacy(signals).recommend).toBe('upgrade');
  });
});

describe('evaluateTierAdequacy — adequate / downgrade signals', () => {
  it('recommends keep when cheap tier runs adequately for windowN (no cheaper tier)', () => {
    // Per spec: "same 5 runs with 0 user-redo → Stage 2 recommends keep"
    const signals = [
      makeSignal('cheap', [
        ev(0, false, 'r-1'),
        ev(0, false, 'r-2'),
        ev(0, false, 'r-3'),
        ev(0, false, 'r-4'),
        ev(0, false, 'r-5'),
      ]),
    ];
    const verdict = evaluateTierAdequacy(signals);
    expect(verdict.recommend).toBe('keep');
    expect(verdict.evidenceCount).toBe(5);
  });

  it('recommends downgrade when premium/balanced tier was over-provisioned', () => {
    const signals = [
      makeSignal('premium', [
        ev(0, false, 'r-1'),
        ev(0, false, 'r-2'),
        ev(0, false, 'r-3'),
        ev(0, false, 'r-4'),
        ev(0, false, 'r-5'),
      ]),
    ];
    expect(evaluateTierAdequacy(signals).recommend).toBe('downgrade');
  });
});

describe('evaluateTierAdequacy — thresholds + safety', () => {
  it('exposes DEFAULT_TIER_ADEQUACY_THRESHOLD with the locked numbers', () => {
    expect(DEFAULT_TIER_ADEQUACY_THRESHOLD).toEqual({
      windowN: 5,
      minRedoUpgrade: 3,
      minOverrideUpgrade: 1,
    });
  });

  it('respects custom threshold (higher windowN delays the verdict)', () => {
    const signals = [
      makeSignal('balanced', [
        ev(0, false, 'r-1'),
        ev(0, false, 'r-2'),
        ev(0, false, 'r-3'),
        ev(0, false, 'r-4'),
        ev(0, false, 'r-5'),
      ]),
    ];
    // windowN=10 means 5 evidence rows is too small → keep.
    expect(
      evaluateTierAdequacy(signals, { windowN: 10, minRedoUpgrade: 3, minOverrideUpgrade: 1 })
        .recommend,
    ).toBe('keep');
  });

  it('clamps negative redo counts to zero (defensive against bad upstream data)', () => {
    const signals = [
      makeSignal('cheap', [
        ev(-99, false, 'r-1'),
        ev(-1, false, 'r-2'),
        ev(0, false, 'r-3'),
        ev(0, false, 'r-4'),
        ev(0, false, 'r-5'),
      ]),
    ];
    // Negative redoes don't count toward upgrade.
    expect(evaluateTierAdequacy(signals).recommend).toBe('keep');
  });

  it('ignores signals whose tier disagrees with the first-seen tier', () => {
    const signals = [
      makeSignal('cheap', [
        ev(0, false, 'r-1'),
        ev(0, false, 'r-2'),
        ev(0, false, 'r-3'),
        ev(0, false, 'r-4'),
        ev(0, false, 'r-5'),
      ]),
      // This row would otherwise trigger upgrade but is on a different tier.
      makeSignal('balanced', [ev(5, true, 'r-99')], 's-2'),
    ];
    const verdict = evaluateTierAdequacy(signals);
    expect(verdict.recommend).toBe('keep');
    // evidenceCount only counts rows whose tier matched (5 from the cheap signal).
    expect(verdict.evidenceCount).toBe(5);
  });
});
