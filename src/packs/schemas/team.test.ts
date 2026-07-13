/**
 * Tests for the team-pack schema (Task 6.1).
 *
 * Coverage (≥ 3 per acceptance criteria):
 *   1. A valid team with two roles parses cleanly.
 *   2. Empty `roles` array → ZodError (min 1 enforced).
 *   3. Role missing `pack` → ZodError.
 *   4. Role missing `model_alias` → ZodError.
 *   5. Optional fields (`handoff_signal`, `instructions`) absent → parses.
 *   6. SubagentRole accepts both optional fields when provided.
 */

import { describe, expect, it } from 'vitest';

import { SubagentRole, Team } from './team.js';

describe('Team schema', () => {
  it('parses a valid team with two roles', () => {
    const result = Team.parse({
      name: 'review-team',
      roles: [
        {
          name: 'code_reviewer',
          pack: 'profession/code-reviewer',
          model_alias: 'reasoning',
          handoff_signal: 'REVIEW_COMPLETE',
        },
        {
          name: 'docs_reviewer',
          pack: 'profession/docs-reviewer',
          model_alias: 'fast_classifier',
        },
      ],
    });
    expect(result.name).toBe('review-team');
    expect(result.roles).toHaveLength(2);
    expect(result.roles[0]?.handoff_signal).toBe('REVIEW_COMPLETE');
    expect(result.roles[1]?.handoff_signal).toBeUndefined();
  });

  it('rejects an empty roles array (min 1 enforced)', () => {
    const result = Team.safeParse({
      name: 'empty-team',
      roles: [],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['roles']);
    }
  });

  it('rejects a role missing `pack`', () => {
    const result = Team.safeParse({
      name: 'broken-team',
      roles: [
        {
          name: 'no_pack_role',
          model_alias: 'reasoning',
        },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('pack'))).toBe(true);
    }
  });

  it('allows an absent model_alias so the executor inherits the parent model', () => {
    const result = Team.parse({
      name: 'inherited-model-team',
      roles: [{ name: 'inherited-model-role', pack: 'profession/code-reviewer' }],
    });
    expect(result.roles[0]?.model_alias).toBeUndefined();
  });

  it('parses a SubagentRole without optional fields', () => {
    const result = SubagentRole.parse({
      name: 'minimal',
      pack: 'profession/x',
    });
    expect(result.model_alias).toBeUndefined();
    expect(result.handoff_signal).toBeUndefined();
    expect(result.instructions).toBeUndefined();
  });

  it('parses a SubagentRole with explicit tool authority and optional handoff fields', () => {
    const result = SubagentRole.parse({
      name: 'full',
      pack: 'profession/x',
      model_alias: 'reasoning',
      tools: ['Read', 'Write'],
      handoff_signal: 'DONE',
      instructions: 'Be terse.',
    });
    expect(result.tools).toEqual(['Read', 'Write']);
    expect(result.handoff_signal).toBe('DONE');
    expect(result.instructions).toBe('Be terse.');
  });

  it('rejects an empty team name', () => {
    const result = Team.safeParse({
      name: '',
      roles: [{ name: 'r', pack: 'p', model_alias: 'a' }],
    });
    expect(result.success).toBe(false);
  });
});
