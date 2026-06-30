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
    expect(skillServesMatches({ domain: 'coding.frontend' }, facets({ domain: 'coding.frontend' }))).toBe(true);
  });

  it('a frontend lens does NOT fire on a coding.backend turn', () => {
    expect(skillServesMatches({ domain: 'coding.frontend' }, facets({ domain: 'coding.backend' }))).toBe(false);
  });

  it('a frontend lens does NOT fire on a SHALLOW coding (full-stack) turn — graceful depth, no false depth', () => {
    expect(skillServesMatches({ domain: 'coding.frontend' }, facets({ domain: 'coding' }))).toBe(false);
  });

  it('a cross-cutting lens (coding) fires on ANY coding.* turn — shallow, frontend, or backend', () => {
    expect(skillServesMatches({ domain: 'coding' }, facets({ domain: 'coding' }))).toBe(true);
    expect(skillServesMatches({ domain: 'coding' }, facets({ domain: 'coding.frontend' }))).toBe(true);
    expect(skillServesMatches({ domain: 'coding' }, facets({ domain: 'coding.backend' }))).toBe(true);
  });

  it('intent-agnostic: a domain lens fires regardless of the turn intent', () => {
    expect(
      skillServesMatches({ domain: 'coding.frontend' }, facets({ intent: 'inform', domain: 'coding.frontend' })),
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
    expect(skillServesMatches({ domain: 'coding.frontend' }, facets({ domain: 'content.seo' }))).toBe(false);
  });
});
