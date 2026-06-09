/**
 * Tests for the TS promotion gate (retire-Rust RES-3a port of gate.rs check_promotion_gate).
 * Mirrors the Rust matrix (s01–s09 + ladder + accumulation). The Rust tests assert on enum
 * variants; here we assert each block's kebab PREFIX + the promote/block decision (the embedded
 * data is informational, not byte-matched to the Rust chrono Display/Debug). `promote` carries no
 * reasons (the consumer never surfaces pass-reasons).
 */
import { describe, expect, it } from 'vitest';

import {
  checkPromotionGate,
  DEFAULT_PROMOTION_CONFIG,
  normalizeCausalNarrative,
  type CausalNarrative,
  type LessonFrontmatter,
  type PromotionConfig,
} from './gate.js';

const NOW = new Date('2026-06-08T12:00:00.000Z');
const hoursAgo = (h: number): string => new Date(NOW.getTime() - h * 3600_000).toISOString();

/** A frontmatter that passes EVERY gate (the s01 baseline). */
function passingFm(over: Partial<LessonFrontmatter> = {}): LessonFrontmatter {
  return {
    status: 'pending',
    createdAt: hoursAgo(48), // > 24h
    appliedCount: 3,
    thumbsDownCount: 0,
    externalSignalSources: ['user_thumbs_up'],
    appliedSessionIds: [],
    causalNarrative: { confidence: 'inferred', evidenceRefs: [] },
    ...over,
  };
}

const blockReasons = (fm: LessonFrontmatter, cfg?: PromotionConfig): string[] => {
  const d = checkPromotionGate(fm, cfg, NOW);
  return d.kind === 'block' ? d.reasons : [];
};
const hasPrefix = (reasons: string[], prefix: string): boolean =>
  reasons.some((r) => r.startsWith(prefix));

describe('checkPromotionGate', () => {
  it('s01: happy path → promote (no reasons field)', () => {
    const d = checkPromotionGate(passingFm(), DEFAULT_PROMOTION_CONFIG, NOW);
    expect(d.kind).toBe('promote');
    expect(d).toEqual({ kind: 'promote' }); // promote carries no reasons
  });

  it('s02: status superseded → block already-superseded', () => {
    expect(hasPrefix(blockReasons(passingFm({ status: 'superseded' })), 'already-superseded')).toBe(
      true,
    );
  });

  it('s03: supersededAt set (status active) → block already-superseded', () => {
    expect(
      hasPrefix(
        blockReasons(passingFm({ status: 'active', supersededAt: '2026-05-12T00:00:00Z' })),
        'already-superseded',
      ),
    ).toBe(true);
  });

  it('s06: createdAt 1h ago → block time-floor', () => {
    expect(hasPrefix(blockReasons(passingFm({ createdAt: hoursAgo(1) })), 'time-floor')).toBe(true);
  });

  it('s07: createdAt exactly 24h ago → promote (age >= floor)', () => {
    expect(
      checkPromotionGate(passingFm({ createdAt: hoursAgo(24) }), DEFAULT_PROMOTION_CONFIG, NOW)
        .kind,
    ).toBe('promote');
  });

  it('future createdAt → dual-emit future-created-at + time-floor with age=0s (clamped)', () => {
    const reasons = blockReasons(
      passingFm({ createdAt: new Date(NOW.getTime() + 3600_000).toISOString() }),
    );
    expect(hasPrefix(reasons, 'future-created-at')).toBe(true);
    expect(reasons).toContain(
      `time-floor: age=0s < required=${Math.floor(DEFAULT_PROMOTION_CONFIG.minAgeMs / 1000)}s`,
    );
  });

  it('non-ISO createdAt → block malformed-created-at', () => {
    expect(
      hasPrefix(blockReasons(passingFm({ createdAt: 'not-a-date' })), 'malformed-created-at'),
    ).toBe(true);
  });

  it('appliedCount < 3 → block insufficient-applied-count', () => {
    expect(
      hasPrefix(blockReasons(passingFm({ appliedCount: 2 })), 'insufficient-applied-count'),
    ).toBe(true);
  });

  it('thumbsDownCount > 0 → block thumbs-down-block', () => {
    expect(hasPrefix(blockReasons(passingFm({ thumbsDownCount: 1 })), 'thumbs-down-block')).toBe(
      true,
    );
  });

  it('empty externalSignalSources → block missing-external-signal-sources', () => {
    expect(blockReasons(passingFm({ externalSignalSources: [] }))).toContain(
      'missing-external-signal-sources',
    );
  });

  it('no narrative → missing; speculative → speculative; observed+no refs → without-evidence; inferred → promote', () => {
    // Build a no-narrative fm by OMISSION (exactOptionalPropertyTypes forbids `: undefined`).
    const noNarr: LessonFrontmatter = {
      status: 'pending',
      createdAt: hoursAgo(48),
      appliedCount: 3,
      thumbsDownCount: 0,
      externalSignalSources: ['user_thumbs_up'],
      appliedSessionIds: [],
    };
    expect(blockReasons(noNarr)).toContain('missing-causal-narrative');
    expect(
      blockReasons(passingFm({ causalNarrative: { confidence: 'speculative', evidenceRefs: [] } })),
    ).toContain('speculative-narrative');
    expect(
      blockReasons(passingFm({ causalNarrative: { confidence: 'observed', evidenceRefs: [] } })),
    ).toContain('observed-confidence-without-evidence-refs');
    expect(
      checkPromotionGate(
        passingFm({ causalNarrative: { confidence: 'observed', evidenceRefs: ['mem-1'] } }),
        DEFAULT_PROMOTION_CONFIG,
        NOW,
      ).kind,
    ).toBe('promote');
  });

  it('observed narrative with undefined evidenceRefs → clean block, never throws (the MAJOR bug)', () => {
    // A pre-normalize / malformed object (e.g. a raw snake_case file cast before the read-side fix)
    // must not crash the gate — the optional-chain guard treats it as no-evidence.
    const fm = passingFm({
      causalNarrative: { confidence: 'observed' } as unknown as CausalNarrative,
    });
    expect(() => blockReasons(fm)).not.toThrow();
    expect(blockReasons(fm)).toContain('observed-confidence-without-evidence-refs');
  });

  describe('normalizeCausalNarrative', () => {
    it('maps snake_case evidence_refs → evidenceRefs', () => {
      const cn = normalizeCausalNarrative({ confidence: 'observed', evidence_refs: ['m1', 'm2'] });
      expect(cn.confidence).toBe('observed');
      expect(cn.evidenceRefs).toEqual(['m1', 'm2']);
    });
    it('camelCase wins when both spellings are present', () => {
      const cn = normalizeCausalNarrative({
        confidence: 'observed',
        evidenceRefs: ['camel'],
        evidence_refs: ['snake'],
      });
      expect(cn.evidenceRefs).toEqual(['camel']);
    });
    it('absent/malformed evidence → []', () => {
      expect(normalizeCausalNarrative({ confidence: 'inferred' }).evidenceRefs).toEqual([]);
      expect(
        normalizeCausalNarrative({ confidence: 'inferred', evidence_refs: 'oops' }).evidenceRefs,
      ).toEqual([]);
    });
    it('preserves richer Rust fields (non-lossy)', () => {
      const cn = normalizeCausalNarrative({
        trigger: 't',
        failure_mode: 'f',
        correction: 'c',
        confidence: 'inferred',
        evidence_refs: ['m'],
      }) as unknown as Record<string, unknown>;
      expect(cn.evidenceRefs).toEqual(['m']);
      expect(cn.trigger).toBe('t');
      expect(cn.failure_mode).toBe('f');
      expect(cn.correction).toBe('c');
    });
  });

  it('origin-diversity inert at default 0; fires when configured', () => {
    expect(
      checkPromotionGate(passingFm({ appliedSessionIds: [] }), DEFAULT_PROMOTION_CONFIG, NOW).kind,
    ).toBe('promote');
    const strict: PromotionConfig = { ...DEFAULT_PROMOTION_CONFIG, minDistinctOrigins: 2 };
    expect(
      hasPrefix(
        blockReasons(passingFm({ appliedSessionIds: ['s1'] }), strict),
        'insufficient-origin-diversity',
      ),
    ).toBe(true);
  });

  it('accumulates ALL violations (no first-fail)', () => {
    const reasons = blockReasons({
      status: 'pending',
      createdAt: hoursAgo(1),
      appliedCount: 0,
      thumbsDownCount: 1,
      externalSignalSources: [],
      appliedSessionIds: [],
    });
    for (const p of [
      'time-floor',
      'insufficient-applied-count',
      'thumbs-down-block',
      'missing-external-signal-sources',
      'missing-causal-narrative',
    ]) {
      expect(hasPrefix(reasons, p), `expected block prefix ${p}`).toBe(true);
    }
  });
});
