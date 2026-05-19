/**
 * Schema round-trip + rejection tests for the runtime type module.
 *
 * Per Task 1.1 acceptance criteria: ≥ 8 cases covering happy path, rejection
 * paths with informative ZodError, and one compile-time narrowing check that
 * proves `z.discriminatedUnion('kind', ...)` produces exhaustive narrowing.
 */

import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import {
  Event,
  Pack,
  Rule,
  Skill,
  Verdict,
  type Event as EventT,
  type Pack as PackT,
  type RuleResult,
  type Verdict as VerdictT,
} from './types.js';

describe('Event', () => {
  it('parses a tool_call event with required fields', () => {
    const parsed = Event.parse({
      kind: 'tool_call',
      tool: 'Bash',
      args: { command: 'git commit --amend' },
    });
    expect(parsed).toEqual({
      kind: 'tool_call',
      tool: 'Bash',
      args: { command: 'git commit --amend' },
    });
  });

  it('parses a prompt_submit event', () => {
    const parsed = Event.parse({ kind: 'prompt_submit', prompt: 'hello' });
    expect(parsed).toEqual({ kind: 'prompt_submit', prompt: 'hello' });
  });

  it('parses a session_end event', () => {
    const parsed = Event.parse({ kind: 'session_end', sessionId: 'sess-1' });
    expect(parsed).toEqual({ kind: 'session_end', sessionId: 'sess-1' });
  });

  it('parses a stop event', () => {
    const parsed = Event.parse({ kind: 'stop', assistantText: 'done' });
    expect(parsed).toEqual({ kind: 'stop', assistantText: 'done' });
  });

  it('rejects a tool_call missing the `tool` field', () => {
    let caught: unknown;
    try {
      Event.parse({ kind: 'tool_call' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(z.ZodError);
    const zerr = caught as z.ZodError;
    // discriminated union picks the right variant — error path includes `tool`
    expect(zerr.issues.some((i) => i.path.join('.') === 'tool')).toBe(true);
  });

  it('narrows on Event.kind exhaustively (compile-time assertNever)', () => {
    // Compile-time exhaustiveness check: if anyone adds a new Event variant
    // without updating this switch, TS will flag the `_exhaustive` assignment.
    const fn = (e: EventT): string => {
      switch (e.kind) {
        case 'tool_call':
          expectTypeOf(e.tool).toEqualTypeOf<string>();
          return e.tool;
        case 'prompt_submit':
          expectTypeOf(e.prompt).toEqualTypeOf<string>();
          return e.prompt;
        case 'session_end':
          expectTypeOf(e.sessionId).toEqualTypeOf<string>();
          return e.sessionId;
        case 'stop':
          expectTypeOf(e.assistantText).toEqualTypeOf<string>();
          return e.assistantText;
        default: {
          const _exhaustive: never = e;
          return _exhaustive;
        }
      }
    };

    expect(fn({ kind: 'tool_call', tool: 'Bash', args: {} })).toBe('Bash');
    expect(fn({ kind: 'prompt_submit', prompt: 'p' })).toBe('p');
    expect(fn({ kind: 'session_end', sessionId: 's' })).toBe('s');
    expect(fn({ kind: 'stop', assistantText: 'a' })).toBe('a');
  });
});

describe('Verdict', () => {
  it('parses with required level + message; ruleId stays undefined', () => {
    const parsed: VerdictT = Verdict.parse({
      level: 'block',
      message: 'amend forbidden',
    });
    expect(parsed.level).toBe('block');
    expect(parsed.message).toBe('amend forbidden');
    expect(parsed.ruleId).toBeUndefined();
  });

  it('parses with optional ruleId set', () => {
    const parsed = Verdict.parse({
      level: 'warn',
      message: 'looks suspicious',
      ruleId: 'r-1',
    });
    expect(parsed.ruleId).toBe('r-1');
  });

  it('rejects an invalid level', () => {
    expect(() => Verdict.parse({ level: 'oops', message: 'm' })).toThrow(z.ZodError);
  });
});

describe('Rule', () => {
  it('applies default kind = track_check when omitted', () => {
    const parsed = Rule.parse({
      id: 'r-1',
      process: [{ call: 'regex_match', args: { pattern: 'x' } }],
    });
    expect(parsed.kind).toBe('track_check');
    if (parsed.kind !== 'track_check') throw new Error('unreachable');
    expect(parsed.process).toHaveLength(1);
  });

  it('accepts destination_check kind explicitly with Phase-4 fields', () => {
    // Phase 4 split: destination_check rules no longer carry `process` — they
    // carry `interval` + `model_alias` + `prompt_template` and fire via the
    // dedicated `check_destination` primitive on the scheduler tick.
    const parsed = Rule.parse({
      id: 'r-2',
      kind: 'destination_check',
      interval: { every_n_tool_calls: 5 },
      prompt_template: 'On goal?',
    });
    expect(parsed.kind).toBe('destination_check');
    if (parsed.kind !== 'destination_check') throw new Error('unreachable');
    expect(parsed.interval.every_n_tool_calls).toBe(5);
    expect(parsed.model_alias).toBe('reasoning');
  });
});

describe('Skill', () => {
  it('fills defaults for load / when_to_load / unloads_when / rules', () => {
    const parsed = Skill.parse({ name: 'git-commit' });
    expect(parsed.load).toBe('lazy');
    expect(parsed.when_to_load).toEqual([]);
    expect(parsed.unloads_when).toEqual([]);
    expect(parsed.rules).toEqual([]);
    expect(parsed.prose).toBeUndefined();
  });
});

describe('Pack', () => {
  it('fills all defaults when only required fields are present', () => {
    const parsed: PackT = Pack.parse({
      name: 'p',
      version: '0.1.0',
      scope: 'workflow',
      goal: 'ship',
    });
    expect(parsed.description).toBe('');
    expect(parsed.requires).toEqual([]);
    expect(parsed.conflicts).toEqual([]);
    expect(parsed.extends).toBeUndefined();
    expect(parsed.evolves).toBe(true);
    expect(parsed.skills).toEqual([]);
  });

  it('rejects a Pack missing version / scope / goal and reports all 3 paths', () => {
    let caught: unknown;
    try {
      Pack.parse({ name: 'p' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(z.ZodError);
    const paths = (caught as z.ZodError).issues.map((i) => i.path.join('.'));
    expect(paths).toContain('version');
    expect(paths).toContain('scope');
    expect(paths).toContain('goal');
  });
});

describe('RuleResult (TS-only union)', () => {
  it('narrows on `kind`', () => {
    const verdictResult: RuleResult = {
      kind: 'verdict',
      verdict: { level: 'pass', message: 'ok' },
    };
    const noVerdict: RuleResult = { kind: 'no_verdict' };
    const errResult: RuleResult = { kind: 'error', error: 'boom', step: 2 };

    const summarize = (r: RuleResult): string => {
      switch (r.kind) {
        case 'verdict':
          return `${r.verdict.level}:${r.verdict.message}`;
        case 'no_verdict':
          return 'none';
        case 'error':
          return `err@${String(r.step)}:${r.error}`;
        default: {
          const _exhaustive: never = r;
          return _exhaustive;
        }
      }
    };

    expect(summarize(verdictResult)).toBe('pass:ok');
    expect(summarize(noVerdict)).toBe('none');
    expect(summarize(errResult)).toBe('err@2:boom');
  });
});
