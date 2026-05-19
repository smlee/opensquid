/**
 * Tests for `skill.yaml` schema.
 *
 * Coverage: minimum-viable skill (just name) with defaults, full skill with
 * rules + process steps, rule kind default, missing process rejection,
 * permissive `when_to_load` (no Phase-3 refinement yet).
 */

import { describe, expect, it } from 'vitest';

import { Rule, Skill } from './skill.js';

describe('Skill schema', () => {
  it('parses a minimum-viable skill (just name) with all defaults', () => {
    const result = Skill.parse({ name: 'noop' });
    expect(result.name).toBe('noop');
    expect(result.load).toBe('lazy');
    expect(result.when_to_load).toEqual([]);
    expect(result.unloads_when).toEqual([]);
    expect(result.rules).toEqual([]);
    expect(result.tools).toEqual([]);
    expect(result.prose).toBeUndefined();
  });

  it('parses a full skill matching design doc §"Skill format" example', () => {
    const result = Skill.parse({
      name: 'git-commit',
      load: 'lazy',
      when_to_load: [{ tool_match: 'Bash' }, { command_pattern: '^git\\s+commit' }],
      unloads_when: ['active_task_completes', 'session_ends'],
      rules: [
        {
          id: 'never-amend',
          process: [
            { call: 'regex_match', args: { pattern: '--amend' }, as: 'hit' },
            { call: 'verdict', if: 'hit' },
          ],
        },
      ],
      prose: 'No --amend.',
    });
    expect(result.rules[0]?.id).toBe('never-amend');
    expect(result.rules[0]?.kind).toBe('track_check');
    expect(result.rules[0]?.process).toHaveLength(2);
  });

  it('normalizes when_to_load shorthand to canonical Matcher form (Phase 3)', () => {
    const result = Skill.parse({
      name: 'x',
      when_to_load: [{ tool_match: 'Bash' }, { command_pattern: '^git' }],
    });
    expect(result.when_to_load).toEqual([
      { kind: 'tool_match', tool: 'Bash' },
      { kind: 'command_pattern', pattern: '^git' },
    ]);
  });

  it('rejects an unknown when_to_load matcher kind (Phase 3 refines)', () => {
    const result = Skill.safeParse({
      name: 'x',
      when_to_load: [{ some_future_matcher: 42, nested: { keys: 'allowed' } }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a rule with empty process array (.min(1))', () => {
    const result = Rule.safeParse({ id: 'r', process: [] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('process'))).toBe(true);
    }
  });

  it('rejects a process step with empty `call`', () => {
    const result = Rule.safeParse({
      id: 'r',
      process: [{ call: '' }],
    });
    expect(result.success).toBe(false);
  });
});
