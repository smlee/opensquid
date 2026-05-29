/**
 * Tests for `skill.yaml` schema.
 *
 * Coverage: minimum-viable skill (just name) with defaults, full skill with
 * rules + process steps, rule kind default, missing process rejection,
 * permissive `when_to_load` (no Phase-3 refinement yet), Phase-4
 * destination_check discriminated-union parsing.
 *
 * AUTO.1: adds `triggers:` block back-compat — omitted block defaults to
 * `[{kind: 'tool_call'}]`; explicit empty list is rejected (no silent
 * fail-open).
 */

import { describe, expect, it } from 'vitest';

import { Rule, Skill, TriggerKind } from './skill.js';

describe('Skill schema', () => {
  it('parses a minimum-viable skill (just name) with all defaults', () => {
    const result = Skill.parse({ name: 'noop' });
    expect(result.name).toBe('noop');
    expect(result.load).toBe('lazy');
    expect(result.when_to_load).toEqual([]);
    expect(result.unloads_when).toEqual([]);
    // AUTO.1: back-compat default — omitting `triggers:` MUST fill exactly
    // `[{kind: 'tool_call'}]` so every Phase 1–7 pack keeps firing on the
    // tool-call hook surface it was authored against.
    expect(result.triggers).toEqual([{ kind: 'tool_call' }]);
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
    const rule0 = result.rules[0];
    if (rule0?.kind !== 'track_check') throw new Error('unreachable');
    expect(rule0.process).toHaveLength(2);
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

// ---------------------------------------------------------------------------
// Phase 4 — destination_check discriminated-union coverage
// ---------------------------------------------------------------------------

describe('Rule schema — Phase 4 destination_check', () => {
  it('parses a fully-populated destination_check rule', () => {
    const result = Rule.parse({
      id: 'g1',
      kind: 'destination_check',
      interval: { every_n_tool_calls: 5 },
      model_alias: 'reasoning',
      prompt_template: 'On goal?',
    });
    expect(result.kind).toBe('destination_check');
    if (result.kind !== 'destination_check') throw new Error('unreachable');
    expect(result.interval.every_n_tool_calls).toBe(5);
    expect(result.model_alias).toBe('reasoning');
    expect(result.prompt_template).toBe('On goal?');
  });

  it("defaults `model_alias` to 'reasoning' when omitted", () => {
    const result = Rule.parse({
      id: 'g1',
      kind: 'destination_check',
      interval: { every_n_tool_calls: 5 },
      prompt_template: 'On goal?',
    });
    if (result.kind !== 'destination_check') throw new Error('unreachable');
    expect(result.model_alias).toBe('reasoning');
  });

  it('accepts an empty `prompt_template` (runtime surfaces empty-prompt errors)', () => {
    const result = Rule.safeParse({
      id: 'g1',
      kind: 'destination_check',
      interval: { every_n_tool_calls: 5 },
      prompt_template: '',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a destination_check rule missing `interval`', () => {
    const result = Rule.safeParse({
      id: 'g1',
      kind: 'destination_check',
      prompt_template: 'On goal?',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('interval'))).toBe(true);
    }
  });

  it('rejects a destination_check rule missing `prompt_template`', () => {
    const result = Rule.safeParse({
      id: 'g1',
      kind: 'destination_check',
      interval: { every_n_tool_calls: 5 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('prompt_template'))).toBe(true);
    }
  });

  it('rejects a destination_check rule with non-positive `every_n_tool_calls`', () => {
    const result = Rule.safeParse({
      id: 'g1',
      kind: 'destination_check',
      interval: { every_n_tool_calls: 0 },
      prompt_template: 'On goal?',
    });
    expect(result.success).toBe(false);
  });

  it('routes by `kind`: track_check default still works without `kind` field', () => {
    // Regression: Phase 1–3 packs wrote rules without `kind:` at all.
    // The preprocess shim must keep that working alongside the new
    // discriminated union.
    const result = Rule.parse({
      id: 'r1',
      process: [{ call: 'verdict', args: { level: 'pass', message: '' } }],
    });
    expect(result.kind).toBe('track_check');
    if (result.kind !== 'track_check') throw new Error('unreachable');
    expect(result.process).toHaveLength(1);
  });

  it('rejects an unknown `kind`', () => {
    const result = Rule.safeParse({
      id: 'r1',
      kind: 'reflection_check',
      process: [{ call: 'verdict' }],
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AUTO.1 — Skill `triggers:` block back-compat + extension surface
// ---------------------------------------------------------------------------

describe('Skill schema — AUTO.1 triggers block', () => {
  it('parses a skill with a multi-trigger list (schedule + file_changed + inbound_channel)', () => {
    const result = Skill.parse({
      name: 'drift-digest',
      load: 'lazy',
      triggers: [
        { kind: 'schedule', cron: '0 9 * * 1' },
        { kind: 'file_changed', paths: ['./src/**/*.ts'] },
        { kind: 'inbound_channel', channel: 'alerts' },
      ],
    });
    expect(result.triggers).toHaveLength(3);
    expect(result.triggers.map((t) => t.kind)).toEqual([
      'schedule',
      'file_changed',
      'inbound_channel',
    ]);
  });

  it('rejects an explicit empty triggers list (no silent fail-open)', () => {
    const result = Skill.safeParse({ name: 'broken', triggers: [] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join('.') === 'triggers')).toBe(true);
    }
  });

  it('rejects a trigger with an unknown kind (engine-vocab discipline)', () => {
    const result = Skill.safeParse({
      name: 'broken',
      triggers: [{ kind: 'mqtt', topic: 'sensors/#' }],
    });
    expect(result.success).toBe(false);
  });

  it('TriggerKind enum is the same 9 literals as EventKind (T-POSTPUSH POSTPUSH.1)', () => {
    expect(TriggerKind.options).toEqual([
      'tool_call',
      'post_tool_call', // T-POSTPUSH POSTPUSH.1
      'prompt_submit',
      'session_end',
      'stop',
      'schedule',
      'webhook',
      'inbound_channel',
      'file_changed',
    ]);
  });
});
