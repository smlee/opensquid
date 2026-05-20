/**
 * Tests for `inheritContext` (Task 6.3).
 *
 * Coverage (≥ 3 per acceptance criteria):
 *   1. Full-stack parent + profession designated → project packs + the one
 *      matching specialty pack (universal, workflow, other specialties /
 *      domains excluded).
 *   2. No profession designated → project packs only (specialty + domain
 *      packs excluded entirely).
 *   3. Empty parent stack → empty result.
 *   4. Profession matches a domain pack (not just specialty) → included.
 *   5. Profession matches a workflow pack → STILL excluded (workflow is
 *      excluded regardless of name match).
 *   6. Profession matches a universal pack → STILL excluded (universal is
 *      excluded regardless of name match).
 *   7. Empty-string profession behaves like undefined (project packs only).
 */

import { describe, expect, it } from 'vitest';

import { inheritContext } from './context_inherit.js';
import type { Pack } from './types.js';

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function makePack(name: string, scope: Pack['scope']): Pack {
  return {
    name,
    version: '0.1.0',
    scope,
    goal: `goal for ${name}`,
    description: '',
    requires: [],
    conflicts: [],
    evolves: true,
    skills: [],
  };
}

// ---------------------------------------------------------------------------
// Cases.
// ---------------------------------------------------------------------------

describe('inheritContext', () => {
  it('keeps project packs + matching specialty when profession designated', () => {
    const parent: Pack[] = [
      makePack('personal-rules', 'universal'),
      makePack('coding', 'domain'),
      makePack('code-reviewer', 'specialty'),
      makePack('rust-expert', 'specialty'),
      makePack('ship-verified', 'workflow'),
      makePack('opensquid-repo', 'project'),
    ];
    const result = inheritContext(parent, 'code-reviewer');
    expect(result.map((p) => p.name).sort()).toEqual(['code-reviewer', 'opensquid-repo']);
  });

  it('returns project packs only when no profession designated', () => {
    const parent: Pack[] = [
      makePack('personal-rules', 'universal'),
      makePack('coding', 'domain'),
      makePack('code-reviewer', 'specialty'),
      makePack('opensquid-repo', 'project'),
    ];
    const result = inheritContext(parent, undefined);
    expect(result.map((p) => p.name)).toEqual(['opensquid-repo']);
  });

  it('returns [] for an empty parent stack', () => {
    const result = inheritContext([], 'code-reviewer');
    expect(result).toEqual([]);
  });

  it('matches profession against domain-scope packs too', () => {
    const parent: Pack[] = [makePack('research', 'domain'), makePack('opensquid-repo', 'project')];
    const result = inheritContext(parent, 'research');
    expect(result.map((p) => p.name).sort()).toEqual(['opensquid-repo', 'research']);
  });

  it('still excludes workflow packs even when profession matches by name', () => {
    const parent: Pack[] = [
      makePack('ship-verified', 'workflow'),
      makePack('opensquid-repo', 'project'),
    ];
    const result = inheritContext(parent, 'ship-verified');
    expect(result.map((p) => p.name)).toEqual(['opensquid-repo']);
  });

  it('still excludes universal packs even when profession matches by name', () => {
    const parent: Pack[] = [
      makePack('personal-rules', 'universal'),
      makePack('opensquid-repo', 'project'),
    ];
    const result = inheritContext(parent, 'personal-rules');
    expect(result.map((p) => p.name)).toEqual(['opensquid-repo']);
  });

  it('treats empty-string profession like undefined (project only)', () => {
    const parent: Pack[] = [
      makePack('code-reviewer', 'specialty'),
      makePack('opensquid-repo', 'project'),
    ];
    const result = inheritContext(parent, '');
    expect(result.map((p) => p.name)).toEqual(['opensquid-repo']);
  });

  it('handles multiple project packs (all included)', () => {
    const parent: Pack[] = [
      makePack('repo-a', 'project'),
      makePack('repo-b', 'project'),
      makePack('coding', 'domain'),
    ];
    const result = inheritContext(parent, undefined);
    expect(result.map((p) => p.name).sort()).toEqual(['repo-a', 'repo-b']);
  });

  it('does not match other specialty packs that share name prefix', () => {
    const parent: Pack[] = [
      makePack('code-reviewer', 'specialty'),
      makePack('code-reviewer-strict', 'specialty'),
    ];
    const result = inheritContext(parent, 'code-reviewer');
    expect(result.map((p) => p.name)).toEqual(['code-reviewer']);
  });
});
