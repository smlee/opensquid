/** ORCH/fractal — skillServesMatches: subset-match a skill's serves against the classified facets. */
import { describe, expect, it } from 'vitest';

import { skillServesMatches } from './skill_serves.js';

import type { Facets } from '../runtime/classify.js';

const facets = (over: Partial<Facets> = {}): Facets => ({
  intent: 'produce',
  project: true,
  confidence: 'high',
  ...over,
});

describe('skillServesMatches (fractal lens gating — hierarchical containment)', () => {
  it('a frontend lens (coding.frontend) fires on a coding.frontend turn', () => {
    expect(
      skillServesMatches({ domain: 'coding.frontend' }, facets({ domain: 'coding.frontend' })),
    ).toBe(true);
  });

  it('a frontend lens does NOT fire on a coding.backend turn', () => {
    expect(
      skillServesMatches({ domain: 'coding.frontend' }, facets({ domain: 'coding.backend' })),
    ).toBe(false);
  });

  it('a frontend lens does NOT fire on a SHALLOW coding (full-stack) turn — graceful depth, no false depth', () => {
    expect(skillServesMatches({ domain: 'coding.frontend' }, facets({ domain: 'coding' }))).toBe(
      false,
    );
  });

  it('a cross-cutting lens (coding) fires on ANY coding.* turn — shallow, frontend, or backend', () => {
    expect(skillServesMatches({ domain: 'coding' }, facets({ domain: 'coding' }))).toBe(true);
    expect(skillServesMatches({ domain: 'coding' }, facets({ domain: 'coding.frontend' }))).toBe(
      true,
    );
    expect(skillServesMatches({ domain: 'coding' }, facets({ domain: 'coding.backend' }))).toBe(
      true,
    );
  });

  it('intent-agnostic: a domain lens fires regardless of the turn intent', () => {
    expect(
      skillServesMatches(
        { domain: 'coding.frontend' },
        facets({ intent: 'inform', domain: 'coding.frontend' }),
      ),
    ).toBe(true);
  });

  it('OR-list semantics: a multi-node lens fires under either node', () => {
    const serves = [{ domain: 'coding.frontend' }, { domain: 'coding.backend' }];
    expect(skillServesMatches(serves, facets({ domain: 'coding.frontend' }))).toBe(true);
    expect(skillServesMatches(serves, facets({ domain: 'coding.backend' }))).toBe(true);
  });

  it('FAIL-OPEN per axis: a domain-declaring lens fires on a turn that carries NO domain (project never declared one)', () => {
    // The bug this guards: classify emits facets with no `domain` when the project hasn't declared one; without
    // per-axis fail-open, EVERY domain-gated lens would be skipped → the whole lens suite silently off.
    expect(skillServesMatches({ domain: 'coding.frontend' }, facets())).toBe(true); // facets() omits domain
    expect(skillServesMatches({ domain: 'coding' }, facets())).toBe(true);
    // but a PRESENT, differing domain still gates (fail-open is per-absent-axis, not a blanket pass):
    expect(
      skillServesMatches({ domain: 'coding.frontend' }, facets({ domain: 'content.seo' })),
    ).toBe(false);
  });
});

// ─── intent-gated lens skills (fullstack-flow lens coarseness fix) ───────────
//
// Five of the ten `domain: coding` lens skills now declare `intent` gates so
// they fire only on task-relevant turns, not on every coding tool_call:
//
//   produce + act : versioning (bumping / publishing), testing (authoring / running)
//   decide + produce : architecture (structural decisions / refactors),
//                      system-design (component design / implementation)
//   produce + decide : accessibility (UI authoring / UI design choices)
//
// Five domain-only lenses remain broad (coding-principles, security,
// observability, performance, compliance) because they are cross-cutting and
// must fire whenever code is touched regardless of the turn's phase.
//
// Intent is always present in the classified facets (classify.ts always sets
// `intent`), so intent gating is a HARD gate — unlike the fail-open on
// the absent `domain` axis.
// ─────────────────────────────────────────────────────────────────────────────

describe('intent-gated lens skills — coding domain (fullstack-flow coarseness fix)', () => {
  /** Coding-domain facets for a given intent (the common case: project with a declared domain). */
  const coding = (intent: Facets['intent']): Facets => ({
    intent,
    domain: 'coding',
    project: true,
    confidence: 'high',
  });

  // ── versioning + testing: produce | act ──────────────────────────────────
  // `[{ domain: coding, intent: produce }, { domain: coding, intent: act }]`
  // Rationale: versioning fires when bumping/migrating (produce) or
  // publishing/releasing (act). Testing fires when authoring tests (produce) or
  // running the suite (act). Neither lens adds value during inform/decide/locate.
  const produceOrAct = [
    { domain: 'coding', intent: 'produce' as const },
    { domain: 'coding', intent: 'act' as const },
  ];

  it('produce|act lens fires on produce (version bump / test authoring)', () => {
    expect(skillServesMatches(produceOrAct, coding('produce'))).toBe(true);
  });

  it('produce|act lens fires on act (publish / test run)', () => {
    expect(skillServesMatches(produceOrAct, coding('act'))).toBe(true);
  });

  it('produce|act lens does NOT fire on inform (unrelated coding intent)', () => {
    expect(skillServesMatches(produceOrAct, coding('inform'))).toBe(false);
  });

  it('produce|act lens does NOT fire on decide (unrelated coding intent)', () => {
    expect(skillServesMatches(produceOrAct, coding('decide'))).toBe(false);
  });

  it('produce|act lens does NOT fire on locate (unrelated coding intent)', () => {
    expect(skillServesMatches(produceOrAct, coding('locate'))).toBe(false);
  });

  // ── architecture + system-design: decide | produce ───────────────────────
  // `[{ domain: coding, intent: decide }, { domain: coding, intent: produce }]`
  // Rationale: architecture/system-design guidance belongs at design (decide)
  // and authoring (produce) time. These lenses do not add value when deploying
  // (act), finding files (locate), explaining (inform), or reformatting
  // (transform).
  const decideOrProduce = [
    { domain: 'coding', intent: 'decide' as const },
    { domain: 'coding', intent: 'produce' as const },
  ];

  it('decide|produce lens fires on decide (structural / design choices)', () => {
    expect(skillServesMatches(decideOrProduce, coding('decide'))).toBe(true);
  });

  it('decide|produce lens fires on produce (structural refactors / building services)', () => {
    expect(skillServesMatches(decideOrProduce, coding('produce'))).toBe(true);
  });

  it('decide|produce lens does NOT fire on act (unrelated coding intent)', () => {
    expect(skillServesMatches(decideOrProduce, coding('act'))).toBe(false);
  });

  it('decide|produce lens does NOT fire on inform (unrelated coding intent)', () => {
    expect(skillServesMatches(decideOrProduce, coding('inform'))).toBe(false);
  });

  it('decide|produce lens does NOT fire on locate (unrelated coding intent)', () => {
    expect(skillServesMatches(decideOrProduce, coding('locate'))).toBe(false);
  });

  // ── domain-only lenses: fire on ANY coding intent ────────────────────────
  // coding-principles, security, observability, performance, compliance stay
  // `{ domain: coding }` because they are cross-cutting: security matters in
  // review (inform), architectural decisions (decide), and production code
  // (produce/act). Intent gating would cause meaningful false-negatives.
  const domainOnly = { domain: 'coding' };

  it('domain-only lens fires on produce (always-relevant cross-cutter)', () => {
    expect(skillServesMatches(domainOnly, coding('produce'))).toBe(true);
  });

  it('domain-only lens fires on inform (always-relevant cross-cutter)', () => {
    expect(skillServesMatches(domainOnly, coding('inform'))).toBe(true);
  });

  it('domain-only lens fires on decide (always-relevant cross-cutter)', () => {
    expect(skillServesMatches(domainOnly, coding('decide'))).toBe(true);
  });

  it('domain-only lens fires on act (always-relevant cross-cutter)', () => {
    expect(skillServesMatches(domainOnly, coding('act'))).toBe(true);
  });

  it('domain-only lens fires on locate (always-relevant cross-cutter)', () => {
    expect(skillServesMatches(domainOnly, coding('locate'))).toBe(true);
  });
});
