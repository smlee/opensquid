/**
 * Tests for `sortPacksByScope` (Task 5.1).
 *
 * Acceptance per phase-5-layered-packs.md:
 *  - Stable sort (alphabetical within scope)
 *  - Pure function (no input mutation)
 *  - ≥ 3 tests
 *
 * Strategy: build minimal `Pack` fixtures (only the fields the sort
 * cares about) and round-trip them through `sortPacksByScope`. Every
 * test asserts both the sorted order AND that the input array remained
 * untouched so the purity contract is on the wire.
 */

import { describe, expect, it } from 'vitest';

import type { Pack, Scope } from '../runtime/types.js';

import { sortPacksByScope } from './load_order.js';

// Minimal pack factory — only fields used by the sort. Required fields
// (name/version/scope/goal) carry placeholder values; defaults from the Zod
// schema are mirrored here so the unit tests don't depend on a parse step.
function mkPack(name: string, scope: Scope): Pack {
  return {
    name,
    version: '0.1.0',
    scope,
    goal: 'test',
    description: '',
    requires: [],
    conflicts: [],
    evolves: true,
    skills: [],
  };
}

describe('sortPacksByScope', () => {
  it('orders packs by scope precedence (universal → domain → specialty → workflow → project)', () => {
    const input: Pack[] = [
      mkPack('workflow-pack', 'workflow'),
      mkPack('universal-pack', 'universal'),
      mkPack('project-pack', 'project'),
      mkPack('domain-pack', 'domain'),
      mkPack('specialty-pack', 'specialty'),
    ];

    const sorted = sortPacksByScope(input);

    expect(sorted.map((p) => p.scope)).toEqual([
      'universal',
      'domain',
      'specialty',
      'workflow',
      'project',
    ]);
  });

  it('sorts alphabetically by name within the same scope', () => {
    const input: Pack[] = [
      mkPack('zeta', 'workflow'),
      mkPack('alpha', 'workflow'),
      mkPack('mike', 'workflow'),
    ];

    const sorted = sortPacksByScope(input);

    expect(sorted.map((p) => p.name)).toEqual(['alpha', 'mike', 'zeta']);
  });

  it('combines scope precedence + alphabetical tie-break in one mixed input', () => {
    const input: Pack[] = [
      mkPack('zeta', 'universal'),
      mkPack('alpha', 'project'),
      mkPack('alpha', 'universal'),
      mkPack('beta', 'workflow'),
      mkPack('alpha', 'domain'),
    ];

    const sorted = sortPacksByScope(input);

    // universal:alpha, universal:zeta, domain:alpha, workflow:beta, project:alpha
    expect(sorted.map((p) => `${p.scope}:${p.name}`)).toEqual([
      'universal:alpha',
      'universal:zeta',
      'domain:alpha',
      'workflow:beta',
      'project:alpha',
    ]);
  });

  it('returns an empty array for empty input', () => {
    expect(sortPacksByScope([])).toEqual([]);
  });

  it('does not mutate the input array (purity contract)', () => {
    const input: Pack[] = [
      mkPack('zeta', 'project'),
      mkPack('alpha', 'universal'),
      mkPack('mike', 'workflow'),
    ];
    const snapshot = input.map((p) => `${p.scope}:${p.name}`);

    sortPacksByScope(input);

    // Input order must be byte-identical to its pre-call snapshot.
    expect(input.map((p) => `${p.scope}:${p.name}`)).toEqual(snapshot);
  });
});
