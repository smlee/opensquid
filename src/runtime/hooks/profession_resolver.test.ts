/**
 * MM.2 — unit tests for resolveProfessionDirective + formatProfessionError.
 */
import { describe, expect, it } from 'vitest';

import type { Team } from '../../packs/schemas/team.js';
import type { NextAction, Pack } from '../types.js';

import {
  type ProfessionResolutionError,
  formatProfessionError,
  resolveProfessionDirective,
} from './profession_resolver.js';

function pack(name: string, usage: 'active' | 'profession' | 'both'): Pack {
  return {
    name,
    version: '0.0.0',
    scope: 'workflow',
    goal: `fixture ${name}`,
    description: '',
    requires: [],
    conflicts: [],
    evolves: true,
    skills: [],
    usage,
    kind: 'focused',
    includes: [],
  };
}

function team(roleNames: string[]): Team {
  return {
    name: 'fixture-team',
    roles: roleNames.map((name) => ({
      name,
      pack: `profession/${name}`,
      model_alias: 'reasoning',
    })),
  };
}

function nextAction(over: Partial<NextAction>): NextAction {
  return { rationale: 'r', ...over };
}

describe('resolveProfessionDirective', () => {
  it('ok: pack exists with usage:both + team with 1 role → returns first role', () => {
    const packs = [pack('pack-architect', 'both')];
    const teamsByPack = new Map([['pack-architect', team(['architect'])]]);
    const result = resolveProfessionDirective(
      nextAction({ profession: 'pack-architect' }),
      packs,
      teamsByPack,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.role.name).toBe('architect');
      expect(result.pack.name).toBe('pack-architect');
    }
  });

  it('unknown-pack: registry empty → error', () => {
    const result = resolveProfessionDirective(nextAction({ profession: 'ghost' }), [], new Map());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.code).toBe('unknown-pack');
      expect((result.reason as { packName: string }).packName).toBe('ghost');
    }
  });

  it('wrong-usage: pack exists with usage:active → error', () => {
    const packs = [pack('my-pack', 'active')];
    const result = resolveProfessionDirective(
      nextAction({ profession: 'my-pack' }),
      packs,
      new Map(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.code).toBe('wrong-usage');
      expect((result.reason as { actualUsage: string }).actualUsage).toBe('active');
    }
  });

  it('missing-team: pack has profession usage but no team in map → error', () => {
    const packs = [pack('my-pack', 'profession')];
    const result = resolveProfessionDirective(
      nextAction({ profession: 'my-pack' }),
      packs,
      new Map(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe('missing-team');
  });

  it('role-not-found: nextAction.args.role names a non-existent role → error', () => {
    const packs = [pack('my-pack', 'both')];
    const teamsByPack = new Map([['my-pack', team(['reviewer'])]]);
    const result = resolveProfessionDirective(
      nextAction({ profession: 'my-pack', args: { role: 'planner' } }),
      packs,
      teamsByPack,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.code).toBe('role-not-found');
      expect((result.reason as { requestedRole: string }).requestedRole).toBe('planner');
    }
  });

  it('multi-role: nextAction.args.role names an existing role → returns that role', () => {
    const packs = [pack('my-pack', 'both')];
    const teamsByPack = new Map([['my-pack', team(['reviewer', 'planner'])]]);
    const result = resolveProfessionDirective(
      nextAction({ profession: 'my-pack', args: { role: 'planner' } }),
      packs,
      teamsByPack,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.role.name).toBe('planner');
  });

  it('defensive: nextAction without profession → error (caller misuse)', () => {
    const result = resolveProfessionDirective(nextAction({ skill: 'x' }), [], new Map());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe('unknown-pack');
  });
});

describe('formatProfessionError', () => {
  const cases: ProfessionResolutionError[] = [
    { code: 'unknown-pack', packName: 'p' },
    { code: 'wrong-usage', packName: 'p', actualUsage: 'active' },
    { code: 'missing-team', packName: 'p' },
    { code: 'no-roles', packName: 'p' },
    { code: 'role-not-found', packName: 'p', requestedRole: 'q' },
  ];
  for (const err of cases) {
    it(`formats ${err.code} with the pack name`, () => {
      const s = formatProfessionError(err);
      expect(s).toContain('p');
      expect(s.length).toBeGreaterThan(20);
    });
  }
});
