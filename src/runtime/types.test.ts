/**
 * Schema round-trip + rejection tests for the runtime type module.
 *
 * Per Task 1.1 acceptance criteria: ≥ 8 cases covering happy path, rejection
 * paths with informative ZodError, and one compile-time narrowing check that
 * proves `z.discriminatedUnion('kind', ...)` produces exhaustive narrowing.
 *
 * AUTO.1 (this revision): adds round-trip + rejection tests for the four new
 * Event variants (schedule / webhook / inbound_channel / file_changed) and
 * extends the exhaustiveness switch from 4 → 8 cases. Default-trigger
 * back-compat is tested on the Skill block here; the YAML-side back-compat
 * (loader doesn't fill `triggers: []` silently) lives in
 * `src/packs/schemas/skill.test.ts`.
 */

import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import {
  DEFAULT_TRIGGERS,
  Event,
  EventKind,
  Pack,
  Rule,
  Skill,
  Trigger,
  Verdict,
  defaultTriggers,
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

  it('narrows on Event.kind exhaustively across all 8 variants (compile-time assertNever)', () => {
    // Compile-time exhaustiveness check: if anyone adds a new Event variant
    // without updating this switch, TS will flag the `_exhaustive` assignment.
    // AUTO.1 widened this from 4 → 8 cases.
    const fn = (e: EventT): string => {
      switch (e.kind) {
        case 'tool_call':
          expectTypeOf(e.tool).toEqualTypeOf<string>();
          return e.tool;
        case 'post_tool_call':
          // T-POSTPUSH POSTPUSH.1 — post-tool-use carries exit_code
          expectTypeOf(e.exit_code).toEqualTypeOf<number>();
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
        case 'session_start':
          expectTypeOf(e.source).toEqualTypeOf<'startup' | 'resume' | 'clear' | 'compact'>();
          return e.source;
        case 'schedule':
          expectTypeOf(e.scheduleId).toEqualTypeOf<string>();
          return e.scheduleId;
        case 'webhook':
          expectTypeOf(e.subscriptionId).toEqualTypeOf<string>();
          return e.subscriptionId;
        case 'inbound_channel':
          expectTypeOf(e.channelUri).toEqualTypeOf<string>();
          return e.channelUri;
        case 'file_changed':
          expectTypeOf(e.path).toEqualTypeOf<string>();
          return e.path;
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
    expect(fn({ kind: 'session_start', source: 'startup' })).toBe('startup');
    expect(
      fn({
        kind: 'schedule',
        scheduleId: 'sch-1',
        fireTime: '2026-05-20T09:00:00Z',
        triggerPayload: {},
      }),
    ).toBe('sch-1');
    expect(
      fn({
        kind: 'webhook',
        subscriptionId: 'sub-1',
        method: 'POST',
        headers: {},
        body: null,
        receivedAt: '2026-05-20T09:00:00Z',
      }),
    ).toBe('sub-1');
    expect(
      fn({
        kind: 'inbound_channel',
        channelUri: 'telegram://-100/1',
        sender: 'u-1',
        text: 'hi',
        receivedAt: '2026-05-20T09:00:00Z',
      }),
    ).toBe('telegram://-100/1');
    expect(
      fn({
        kind: 'file_changed',
        path: 'src/x.ts',
        changeKind: 'add',
        changedAt: '2026-05-20T09:00:00Z',
      }),
    ).toBe('src/x.ts');
  });
});

// ---------------------------------------------------------------------------
// AUTO.1 — round-trip + rejection tests for the four new Event variants.
//
// One it() per variant covering: required fields parse, missing-required
// field rejection, and narrowing inside `switch (event.kind)`. The
// exhaustiveness test above already covers narrowing across all 8 variants
// in one pass; these tests focus on per-variant payload correctness.
// ---------------------------------------------------------------------------

describe('Event (AUTO.1 new variants)', () => {
  it('parses a schedule event and applies triggerPayload default', () => {
    const parsed = Event.parse({
      kind: 'schedule',
      scheduleId: 'weekly-digest',
      fireTime: '2026-05-25T09:00:00Z',
    });
    expect(parsed.kind).toBe('schedule');
    if (parsed.kind !== 'schedule') throw new Error('unreachable');
    expect(parsed.scheduleId).toBe('weekly-digest');
    expect(parsed.fireTime).toBe('2026-05-25T09:00:00Z');
    // `.default({})` materializes when the field is omitted.
    expect(parsed.triggerPayload).toEqual({});
  });

  it('parses a webhook event with method enum + open body', () => {
    const parsed = Event.parse({
      kind: 'webhook',
      subscriptionId: 'gh-issues',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { action: 'opened', issue: { number: 42 } },
      receivedAt: '2026-05-20T09:00:00Z',
    });
    expect(parsed.kind).toBe('webhook');
    if (parsed.kind !== 'webhook') throw new Error('unreachable');
    expect(parsed.method).toBe('POST');
    expect(parsed.headers['content-type']).toBe('application/json');
    // `body` is `z.unknown()` — the parse preserves the structure verbatim
    // for the downstream webhook intake to refine.
    expect(parsed.body).toEqual({ action: 'opened', issue: { number: 42 } });
  });

  it('rejects a webhook event missing subscriptionId with a ZodError citing that path', () => {
    let caught: unknown;
    try {
      Event.parse({
        kind: 'webhook',
        method: 'GET',
        headers: {},
        body: null,
        receivedAt: '2026-05-20T09:00:00Z',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(z.ZodError);
    const zerr = caught as z.ZodError;
    expect(zerr.issues.some((i) => i.path.join('.') === 'subscriptionId')).toBe(true);
  });

  it('parses an inbound_channel event with optional threadKey', () => {
    const withThread = Event.parse({
      kind: 'inbound_channel',
      channelUri: 'telegram://-1001234567890/42',
      sender: '8075471258',
      text: 'ship it',
      threadKey: '42',
      receivedAt: '2026-05-20T09:00:00Z',
    });
    expect(withThread.kind).toBe('inbound_channel');
    if (withThread.kind !== 'inbound_channel') throw new Error('unreachable');
    expect(withThread.threadKey).toBe('42');

    const withoutThread = Event.parse({
      kind: 'inbound_channel',
      channelUri: 'slack://C123/general',
      sender: 'U456',
      text: 'hi',
      receivedAt: '2026-05-20T09:00:00Z',
    });
    if (withoutThread.kind !== 'inbound_channel') throw new Error('unreachable');
    expect(withoutThread.threadKey).toBeUndefined();
  });

  it('parses a file_changed event and constrains changeKind to the three flavors', () => {
    for (const changeKind of ['add', 'change', 'unlink'] as const) {
      const parsed = Event.parse({
        kind: 'file_changed',
        path: 'src/x.ts',
        changeKind,
        changedAt: '2026-05-20T09:00:00Z',
      });
      if (parsed.kind !== 'file_changed') throw new Error('unreachable');
      expect(parsed.changeKind).toBe(changeKind);
    }
    // Reject any other changeKind value.
    expect(() =>
      Event.parse({
        kind: 'file_changed',
        path: 'src/x.ts',
        changeKind: 'rename',
        changedAt: '2026-05-20T09:00:00Z',
      }),
    ).toThrow(z.ZodError);
  });

  it('rejects an unknown event kind with a discriminated-union error', () => {
    let caught: unknown;
    try {
      Event.parse({ kind: 'reflection_check', payload: {} });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(z.ZodError);
    const zerr = caught as z.ZodError;
    // The discriminated-union error points at `kind` (invalid discriminator).
    expect(zerr.issues.some((i) => i.path.join('.') === 'kind')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AUTO.1 — EventKind enum + Trigger + DEFAULT_TRIGGERS
// ---------------------------------------------------------------------------

describe('EventKind enum', () => {
  it('lists exactly the 10 Event discriminator literals', () => {
    expect(EventKind.options).toEqual([
      'tool_call',
      'post_tool_call', // T-POSTPUSH POSTPUSH.1
      'prompt_submit',
      'session_end',
      'stop',
      'session_start', // T-HANDOFF-HARDENING HH6.1
      'schedule',
      'webhook',
      'inbound_channel',
      'file_changed',
    ]);
  });

  it('rejects an unknown kind', () => {
    expect(() => EventKind.parse('reflection_check')).toThrow(z.ZodError);
  });
});

describe('Trigger', () => {
  it('parses every trigger variant', () => {
    expect(Trigger.parse({ kind: 'tool_call' }).kind).toBe('tool_call');
    expect(Trigger.parse({ kind: 'prompt_submit' }).kind).toBe('prompt_submit');
    expect(Trigger.parse({ kind: 'session_end' }).kind).toBe('session_end');
    expect(Trigger.parse({ kind: 'stop' }).kind).toBe('stop');
    expect(Trigger.parse({ kind: 'schedule', cron: '0 9 * * 1' }).kind).toBe('schedule');
    expect(Trigger.parse({ kind: 'webhook', path: '/gh' }).kind).toBe('webhook');
    expect(Trigger.parse({ kind: 'inbound_channel', channel: 'alerts' }).kind).toBe(
      'inbound_channel',
    );
    expect(Trigger.parse({ kind: 'file_changed', paths: ['./src/**/*.ts'] }).kind).toBe(
      'file_changed',
    );
  });

  it('accepts cost_tier on trigger sources that route to subscription pools (AUTO.7)', () => {
    const t = Trigger.parse({ kind: 'schedule', cron: '0 9 * * 1', cost_tier: 'cheap' });
    if (t.kind !== 'schedule') throw new Error('unreachable');
    expect(t.cost_tier).toBe('cheap');
  });

  it('rejects an unknown trigger kind', () => {
    expect(() => Trigger.parse({ kind: 'mqtt' })).toThrow(z.ZodError);
  });
});

describe('DEFAULT_TRIGGERS', () => {
  it('contains exactly one tool_call entry — the Phase 1–7 back-compat default', () => {
    expect(DEFAULT_TRIGGERS).toEqual([{ kind: 'tool_call' }]);
    expect(DEFAULT_TRIGGERS).toHaveLength(1);
  });

  it('defaultTriggers() returns a fresh mutable copy per call (Zod default-factory contract)', () => {
    const a = defaultTriggers();
    const b = defaultTriggers();
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    // Mutating one must not affect the other or the frozen constant.
    a.push({ kind: 'schedule', cron: '0 9 * * 1' });
    expect(b).toEqual([{ kind: 'tool_call' }]);
    expect(DEFAULT_TRIGGERS).toEqual([{ kind: 'tool_call' }]);
  });
});

describe('Verdict', () => {
  it('parses with required level + message; ruleId stays undefined', () => {
    const parsed: VerdictT = Verdict.parse({
      level: 'block',
      message: 'amend forbidden',
    });
    expect(parsed.level).toBe('block');
    // T-ASC ASC.3: Verdict is a discriminated union; narrow on `level` to
    // access the message-bearing branch's fields.
    if (parsed.level !== 'directive') {
      expect(parsed.message).toBe('amend forbidden');
    }
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
  it('fills defaults for load / when_to_load / unloads_when / triggers / rules', () => {
    const parsed = Skill.parse({ name: 'git-commit' });
    expect(parsed.load).toBe('lazy');
    expect(parsed.when_to_load).toEqual([]);
    expect(parsed.unloads_when).toEqual([]);
    // AUTO.1: omitted `triggers:` block defaults to a single tool_call entry,
    // preserving Phase 1–7 dispatcher behavior.
    expect(parsed.triggers).toEqual([{ kind: 'tool_call' }]);
    expect(parsed.rules).toEqual([]);
    expect(parsed.prose).toBeUndefined();
  });

  it('rejects an explicitly empty triggers list (no silent fail-open)', () => {
    const result = Skill.safeParse({ name: 'broken', triggers: [] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join('.') === 'triggers')).toBe(true);
    }
  });

  it('accepts a multi-kind triggers list (tool_call + schedule)', () => {
    const parsed = Skill.parse({
      name: 'drift-digest',
      triggers: [{ kind: 'tool_call' }, { kind: 'schedule', cron: '0 9 * * 1' }],
    });
    expect(parsed.triggers).toHaveLength(2);
    expect(parsed.triggers.map((t) => t.kind)).toEqual(['tool_call', 'schedule']);
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
  it('narrows on `kind` across all 4 variants (compile-time assertNever)', () => {
    // G.4 widened RuleResult from 3 → 4 variants by adding `inject_context`.
    // The exhaustive switch + `_exhaustive: never` assignment is the
    // compile-time guarantee that every variant is handled; CI fails if a
    // new variant lands without updating this switch.
    const verdictResult: RuleResult = {
      kind: 'verdict',
      verdict: { level: 'pass', message: 'ok' },
    };
    const noVerdict: RuleResult = { kind: 'no_verdict' };
    const errResult: RuleResult = { kind: 'error', error: 'boom', step: 2 };
    const injectResult: RuleResult = {
      kind: 'inject_context',
      content: '[opensquid recall] hi',
    };

    const summarize = (r: RuleResult): string => {
      switch (r.kind) {
        case 'verdict':
          return `${r.verdict.level}:${r.verdict.message}`;
        case 'directive':
          // T-ASC ASC.3 — directive variant is a peer to verdict; surfaces
          // the next_action's skill XOR tool target.
          return `dir:${r.directive.next_action.skill ?? r.directive.next_action.tool ?? '?'}`;
        case 'no_verdict':
          return 'none';
        case 'error':
          return `err@${String(r.step)}:${r.error}`;
        case 'inject_context':
          return `inj:${r.content}`;
        default: {
          const _exhaustive: never = r;
          return _exhaustive;
        }
      }
    };

    expect(summarize(verdictResult)).toBe('pass:ok');
    expect(summarize(noVerdict)).toBe('none');
    expect(summarize(errResult)).toBe('err@2:boom');
    expect(summarize(injectResult)).toBe('inj:[opensquid recall] hi');
  });

  it('inject_context variant carries a `content: string` field (round-trip)', () => {
    // Round-trip: TS-only union has no Zod schema, so the "round-trip" is
    // a structural check — we construct, narrow, and re-extract the
    // content. This guards against accidental shape drift (e.g. someone
    // renaming `content` to `text`) in a future refactor.
    const payload =
      '[opensquid recall — top 2 memories for "fix the bug"]\n\n1. (score=0.812, source=fused)\nremember the off-by-one in foo()\n\n2. (score=0.701, source=semantic)\nbar() returns null on empty input\n\n[end opensquid recall]';
    const r: RuleResult = { kind: 'inject_context', content: payload };
    if (r.kind !== 'inject_context') throw new Error('unreachable');
    expect(r.content).toBe(payload);
    expect(r.content.startsWith('[opensquid recall')).toBe(true);
    expect(r.content.endsWith('[end opensquid recall]')).toBe(true);
  });
});
