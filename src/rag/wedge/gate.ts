/**
 * Promotion gate — the marketing wedge (TS port of the Rust
 * `engine/src/engine/lessons/gate.rs` `check_promotion_gate`, retire-Rust RES-3a).
 *
 * Pure + synchronous: given a lesson's frontmatter + a `PromotionConfig` + `now`,
 * decide whether it is eligible for promotion. Accumulates ALL violations (no
 * first-fail) so callers render the full picture. The wedge against self-grading:
 * promotion refuses to take frontmatter at face value (24h dwell, ≥3 applied,
 * external signal required, no thumbs-down, non-speculative narrative).
 *
 * Block `reasons` carry a stable kebab PREFIX (the wire contract `promote_lesson`
 * surfaces as opaque strings, `src/functions/lessons.ts`); the embedded data
 * (timestamps/counts) is informational + TS-rendered (NOT byte-matched to the
 * Rust chrono Display/Debug). `promote` carries no reasons — the consumer never
 * surfaces pass-reasons.
 *
 * NOTE (the wedge invariant): the Rust gate's `TamperedAge` anti-backdate check
 * relied on filesystem birthtime, which libSQL has no per-row equivalent of. It is
 * DROPPED here; the invariant migrates to the store (RES-3b) as a HARD requirement:
 * `createdAt` MUST be store-owned (the DB insert time, never caller-supplied), or
 * the 24h time-floor below is backdate-bypassable with no backstop.
 *
 * Imports from: nothing (leaf, pure). Imported by: RES-3b lesson store (not yet wired).
 */

export type Confidence = 'observed' | 'inferred' | 'speculative';

export interface CausalNarrative {
  confidence: Confidence;
  evidenceRefs: string[];
}

export type LessonStatus = 'pending' | 'active' | 'promoted' | 'superseded' | 'discarded';

export interface LessonFrontmatter {
  status: LessonStatus;
  supersededAt?: string;
  /** ISO 8601. STORE-OWNED in RES-3b (the dropped-TamperedAge invariant). */
  createdAt: string;
  appliedCount: number;
  thumbsDownCount: number;
  externalSignalSources: string[];
  appliedSessionIds: string[];
  causalNarrative?: CausalNarrative;
}

export interface PromotionConfig {
  minAgeMs: number;
  minAppliedCount: number;
  minDistinctOrigins: number;
}

/** gate.rs:75-87 — 24h dwell, ≥3 applied, origin-diversity disabled by default. */
export const DEFAULT_PROMOTION_CONFIG: PromotionConfig = {
  minAgeMs: 24 * 60 * 60 * 1000,
  minAppliedCount: 3,
  minDistinctOrigins: 0,
};

export type GateDecision = { kind: 'promote' } | { kind: 'block'; reasons: string[] };

/**
 * Faithful port of `check_promotion_gate` (gate.rs:325-454): accumulate ALL
 * violations in the stable 1→8 order; return `block` if any, else `promote`.
 */
export function checkPromotionGate(
  fm: LessonFrontmatter,
  config: PromotionConfig = DEFAULT_PROMOTION_CONFIG,
  now: Date = new Date(),
): GateDecision {
  const blocks: string[] = [];
  const requiredSec = Math.floor(config.minAgeMs / 1000);

  // 1. superseded (gate.rs:335)
  if (fm.status === 'superseded' || fm.supersededAt !== undefined) {
    blocks.push('already-superseded');
  }

  // 2. created_at parse + future + 24h time-floor (gate.rs:340-364). A future date
  //    dual-emits future-created-at + time-floor; age is CLAMPED to 0 (a future date
  //    can't satisfy a positive floor — never a negative age).
  const createdMs = Date.parse(fm.createdAt);
  if (Number.isNaN(createdMs)) {
    blocks.push(`malformed-created-at: ${JSON.stringify(fm.createdAt)}`);
  } else if (createdMs > now.getTime()) {
    blocks.push(`future-created-at: ${fm.createdAt}`);
    blocks.push(`time-floor: age=0s < required=${requiredSec}s`);
  } else if (now.getTime() - createdMs < config.minAgeMs) {
    const ageSec = Math.floor((now.getTime() - createdMs) / 1000);
    blocks.push(`time-floor: age=${ageSec}s < required=${requiredSec}s`);
  }
  // (TamperedAge DROPPED — no per-row birthtime in libSQL; RES-3b owns createdAt)

  // 3. applied-count floor (gate.rs:390)
  if (fm.appliedCount < config.minAppliedCount) {
    blocks.push(
      `insufficient-applied-count: observed=${fm.appliedCount} < required=${config.minAppliedCount}`,
    );
  }

  // 4. thumbs-down hard block (gate.rs:400)
  if (fm.thumbsDownCount > 0) {
    blocks.push(`thumbs-down-block: count=${fm.thumbsDownCount}`);
  }

  // 5. external signal required (gate.rs:409)
  if (fm.externalSignalSources.length === 0) {
    blocks.push('missing-external-signal-sources');
  }

  // 5b. origin diversity — inert at the default 0 (gate.rs:420)
  if (config.minDistinctOrigins > 0 && fm.appliedSessionIds.length < config.minDistinctOrigins) {
    blocks.push(
      `insufficient-origin-diversity: distinct_sessions=${fm.appliedSessionIds.length} < required=${config.minDistinctOrigins}`,
    );
  }

  // 6. causal narrative ladder (gate.rs:433-447)
  if (fm.causalNarrative === undefined) {
    blocks.push('missing-causal-narrative');
  } else if (fm.causalNarrative.confidence === 'speculative') {
    blocks.push('speculative-narrative');
  } else if (
    fm.causalNarrative.confidence === 'observed' &&
    fm.causalNarrative.evidenceRefs.length === 0
  ) {
    blocks.push('observed-confidence-without-evidence-refs');
  }

  return blocks.length === 0 ? { kind: 'promote' } : { kind: 'block', reasons: blocks };
}
