/**
 * Tests for `applyExtends` + `detectExtendsCycle` (Task 5.2).
 *
 * Acceptance per phase-5-layered-packs.md:
 *  - Child overrides parent on field collision
 *  - Skills merged by name (child overrides)
 *  - Cycle detection works
 *  - No mutation of parent pack
 *  - ≥ 4 tests
 */

import { describe, expect, it } from 'vitest';

import type { Pack, Skill } from '../runtime/types.js';

import { applyExtends, detectExtendsCycle } from './apply_extends.js';

// Skill factory — only the runtime-validated fields. `rules` left empty
// because none of these tests exercise rule semantics; merge cares about
// `name` only.
function mkSkill(name: string, prose?: string): Skill {
  return {
    name,
    load: 'lazy',
    when_to_load: [],
    requires: [],
    unloads_when: [],
    triggers: [{ kind: 'tool_call' }],
    rules: [],
    prose,
  };
}

function mkPack(overrides: Partial<Pack> & { name: string }): Pack {
  return {
    name: overrides.name,
    version: overrides.version ?? '0.1.0',
    scope: overrides.scope ?? 'workflow',
    goal: overrides.goal ?? 'test goal',
    description: overrides.description ?? '',
    requires: overrides.requires ?? [],
    conflicts: overrides.conflicts ?? [],
    extends: overrides.extends,
    evolves: overrides.evolves ?? true,
    skills: overrides.skills ?? [],
  };
}

describe('applyExtends', () => {
  it('merges skills by name — child overrides parent, parent-only skills carry through, child-new skills append', () => {
    const parent = mkPack({
      name: 'parent',
      skills: [mkSkill('alpha', 'parent-alpha'), mkSkill('beta', 'parent-beta')],
    });
    const child = mkPack({
      name: 'child',
      extends: 'parent',
      skills: [
        mkSkill('alpha', 'child-alpha'), // overrides parent's alpha
        mkSkill('gamma', 'child-gamma'), // new skill
      ],
    });

    const merged = applyExtends(child, parent);

    // 3 unique skills total: alpha (overridden), beta (parent-only), gamma (new).
    expect(merged.skills).toHaveLength(3);
    const byName = new Map(merged.skills.map((s) => [s.name, s.prose]));
    expect(byName.get('alpha')).toBe('child-alpha');
    expect(byName.get('beta')).toBe('parent-beta');
    expect(byName.get('gamma')).toBe('child-gamma');
  });

  it('child wins on top-level field collisions (name, version, scope, goal, evolves)', () => {
    const parent = mkPack({
      name: 'parent',
      version: '0.1.0',
      scope: 'universal',
      goal: 'parent-goal',
      description: 'parent-desc',
      evolves: true,
    });
    const child = mkPack({
      name: 'child',
      version: '0.2.0',
      scope: 'project',
      goal: 'child-goal',
      description: 'child-desc',
      evolves: false,
      extends: 'parent',
    });

    const merged = applyExtends(child, parent);

    expect(merged.name).toBe('child');
    expect(merged.version).toBe('0.2.0');
    expect(merged.scope).toBe('project');
    expect(merged.goal).toBe('child-goal');
    expect(merged.description).toBe('child-desc');
    expect(merged.evolves).toBe(false);
    expect(merged.extends).toBe('parent');
  });

  it('child empty description falls back to parent description', () => {
    const parent = mkPack({ name: 'parent', description: 'parent-desc' });
    const child = mkPack({ name: 'child', extends: 'parent', description: '' });

    const merged = applyExtends(child, parent);

    expect(merged.description).toBe('parent-desc');
  });

  it('does not mutate the parent pack (defensive clone)', () => {
    const parent = mkPack({
      name: 'parent',
      goal: 'parent-goal',
      skills: [mkSkill('alpha', 'parent-alpha')],
      requires: ['dep-a'],
    });
    const parentSnapshot = JSON.parse(JSON.stringify(parent)) as Pack;
    const child = mkPack({
      name: 'child',
      extends: 'parent',
      goal: 'child-goal',
      skills: [mkSkill('alpha', 'child-alpha')],
      requires: ['dep-b'],
    });

    const merged = applyExtends(child, parent);

    // Parent unchanged.
    expect(parent).toEqual(parentSnapshot);
    // And mutating the merged result must not leak back into parent.
    merged.skills.push(mkSkill('zeta', 'leaked'));
    merged.requires.push('leaked-dep');
    expect(parent.skills).toHaveLength(1);
    expect(parent.skills[0]?.prose).toBe('parent-alpha');
    expect(parent.requires).toEqual(['dep-a']);
  });

  it('lists (requires, conflicts) replace rather than union', () => {
    const parent = mkPack({
      name: 'parent',
      requires: ['parent-dep-1', 'parent-dep-2'],
      conflicts: ['parent-conflict'],
    });
    const child = mkPack({
      name: 'child',
      extends: 'parent',
      requires: ['child-dep'],
      conflicts: [],
    });

    const merged = applyExtends(child, parent);

    expect(merged.requires).toEqual(['child-dep']);
    expect(merged.conflicts).toEqual([]);
  });
});

describe('detectExtendsCycle', () => {
  it('detects a two-pack cycle (A extends B, B extends A)', () => {
    const a = mkPack({ name: 'a', extends: 'b' });
    const b = mkPack({ name: 'b', extends: 'a' });

    const cycles = detectExtendsCycle([a, b]);

    // Both start nodes are part of the cycle; both surface as cycle-starts.
    expect(cycles.sort()).toEqual(['a', 'b']);
  });

  it('detects a self-extends cycle (A extends A)', () => {
    const a = mkPack({ name: 'a', extends: 'a' });

    const cycles = detectExtendsCycle([a]);

    expect(cycles).toEqual(['a']);
  });

  it('returns empty for a healthy linear chain (A extends B extends C)', () => {
    const a = mkPack({ name: 'a', extends: 'b' });
    const b = mkPack({ name: 'b', extends: 'c' });
    const c = mkPack({ name: 'c' });

    expect(detectExtendsCycle([a, b, c])).toEqual([]);
  });

  it('returns empty when no pack uses extends', () => {
    const a = mkPack({ name: 'a' });
    const b = mkPack({ name: 'b' });

    expect(detectExtendsCycle([a, b])).toEqual([]);
  });
});
