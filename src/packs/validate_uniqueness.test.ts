/**
 * Tests for `validateUniqueSkillNames` (Task 2.5).
 *
 * Coverage matches the task spec §"Test fixtures" + acceptance criteria:
 *   1. Two packs both declaring `git` → 1 issue, packs=['pack-a', 'pack-b'].
 *   2. Two packs with distinct skill names → empty.
 *   3. Single pack with two skills sharing a name → issue listing the pack
 *      twice (surface, don't merge).
 *   4. Zero packs → empty.
 */

import { describe, expect, it } from 'vitest';

import { Pack } from '../runtime/types.js';

import { validateUniqueSkillNames } from './validate_uniqueness.js';

function makePack(name: string, skillNames: string[]): Pack {
  return Pack.parse({
    name,
    version: '0.0.0',
    scope: 'universal',
    goal: 'test',
    skills: skillNames.map((n) => ({ name: n })),
  });
}

describe('validateUniqueSkillNames', () => {
  it('flags a single collision across two packs', () => {
    const issues = validateUniqueSkillNames([
      makePack('pack-a', ['git']),
      makePack('pack-b', ['git']),
    ]);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toEqual({ skill: 'git', packs: ['pack-a', 'pack-b'] });
  });

  it('returns empty when no skill names collide', () => {
    const issues = validateUniqueSkillNames([
      makePack('pack-a', ['git']),
      makePack('pack-b', ['docs']),
    ]);

    expect(issues).toEqual([]);
  });

  it('lists the pack twice when one pack declares the same skill twice', () => {
    const issues = validateUniqueSkillNames([makePack('pack-a', ['git', 'git'])]);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toEqual({ skill: 'git', packs: ['pack-a', 'pack-a'] });
  });

  it('returns empty for zero packs', () => {
    expect(validateUniqueSkillNames([])).toEqual([]);
  });
});
