/**
 * Tests for event-inspection primitives (`tool_name`, `tool_args`, `cwd`,
 * `last_assistant_message`, `match_command`).
 *
 * Per Task 1.5 acceptance criteria: ≥ 8 cases. Fixture Events cover all
 * four kinds (tool_call / prompt_submit / session_end / stop) so wrong-kind
 * paths are exercised on every accessor. `match_command` has dedicated
 * happy-path / miss / wrong-kind / bad-regex / custom-target coverage.
 *
 * No filesystem access here — these primitives are pure reads off
 * `EvalCtx.event`, so the suite needs no temp dir.
 */

import { describe, expect, it } from 'vitest';

import { ok } from '../runtime/result.js';
import type { Event } from '../runtime/types.js';

import { registerEventFunctions } from './event.js';
import { type EvalCtx, FunctionRegistry } from './registry.js';

// ---------------------------------------------------------------------------
// Scaffolding — fresh registry per test + EvalCtx factory that takes an Event.
// ---------------------------------------------------------------------------

function freshRegistry(): FunctionRegistry {
  const reg = new FunctionRegistry();
  registerEventFunctions(reg);
  return reg;
}

function createTestCtx(event: Event): EvalCtx {
  return {
    event,
    bindings: new Map<string, unknown>(),
    sessionId: 'test-session',
    packId: 'test-pack',
  };
}

// ---------------------------------------------------------------------------
// tool_name — returns tool string on tool_call, null otherwise.
// ---------------------------------------------------------------------------

describe('tool_name', () => {
  it('returns the tool string on a tool_call event', async () => {
    const reg = freshRegistry();
    const ctx = createTestCtx({ kind: 'tool_call', tool: 'Bash', args: {} });

    const result = await reg.call('tool_name', {}, ctx);

    expect(result).toEqual(ok('Bash'));
  });

  it('returns ok(null) on a prompt_submit event (wrong kind)', async () => {
    const reg = freshRegistry();
    const ctx = createTestCtx({ kind: 'prompt_submit', prompt: 'hi' });

    const result = await reg.call('tool_name', {}, ctx);

    expect(result).toEqual(ok(null));
  });
});

// ---------------------------------------------------------------------------
// tool_args — returns args record on tool_call, null otherwise.
// ---------------------------------------------------------------------------

describe('tool_args', () => {
  it('returns the args record on a tool_call event', async () => {
    const reg = freshRegistry();
    const ctx = createTestCtx({
      kind: 'tool_call',
      tool: 'Bash',
      args: { command: 'git status' },
    });

    const result = await reg.call('tool_args', {}, ctx);

    expect(result).toEqual(ok({ command: 'git status' }));
  });

  it('returns ok(null) on a session_end event (wrong kind)', async () => {
    const reg = freshRegistry();
    const ctx = createTestCtx({ kind: 'session_end', sessionId: 's1' });

    const result = await reg.call('tool_args', {}, ctx);

    expect(result).toEqual(ok(null));
  });
});

// ---------------------------------------------------------------------------
// cwd — returns cwd string on tool_call with cwd set, null when absent.
// ---------------------------------------------------------------------------

describe('cwd', () => {
  it('returns the cwd string on a tool_call with cwd set', async () => {
    const reg = freshRegistry();
    const ctx = createTestCtx({
      kind: 'tool_call',
      tool: 'Bash',
      args: {},
      cwd: '/some/path',
    });

    const result = await reg.call('cwd', {}, ctx);

    expect(result).toEqual(ok('/some/path'));
  });

  it('returns ok(null) on a tool_call without cwd', async () => {
    const reg = freshRegistry();
    const ctx = createTestCtx({ kind: 'tool_call', tool: 'Bash', args: {} });

    const result = await reg.call('cwd', {}, ctx);

    expect(result).toEqual(ok(null));
  });
});

// ---------------------------------------------------------------------------
// last_assistant_message — returns assistantText on stop, null otherwise.
// ---------------------------------------------------------------------------

describe('last_assistant_message', () => {
  it('returns assistantText on a stop event', async () => {
    const reg = freshRegistry();
    const ctx = createTestCtx({ kind: 'stop', assistantText: 'hello' });

    const result = await reg.call('last_assistant_message', {}, ctx);

    expect(result).toEqual(ok('hello'));
  });

  it('returns ok(null) on a tool_call event (wrong kind)', async () => {
    const reg = freshRegistry();
    const ctx = createTestCtx({ kind: 'tool_call', tool: 'Bash', args: {} });

    const result = await reg.call('last_assistant_message', {}, ctx);

    expect(result).toEqual(ok(null));
  });

  // RJ.1 — the prior assistant turn is also available at prompt_submit, filled
  // by the UPS hook from the transcript (the settled, no-off-by-one path).
  it('returns priorAssistantText on a prompt_submit event', async () => {
    const reg = freshRegistry();
    const ctx = createTestCtx({
      kind: 'prompt_submit',
      prompt: 'next',
      priorAssistantText: 'I just committed the fix',
    });

    const result = await reg.call('last_assistant_message', {}, ctx);

    expect(result).toEqual(ok('I just committed the fix'));
  });

  it('returns ok(null) on a prompt_submit event without priorAssistantText', async () => {
    const reg = freshRegistry();
    const ctx = createTestCtx({ kind: 'prompt_submit', prompt: 'next' });

    const result = await reg.call('last_assistant_message', {}, ctx);

    expect(result).toEqual(ok(null));
  });
});

// ---------------------------------------------------------------------------
// recent_turns (FU.2) — returns recentTurns on prompt_submit, null otherwise.
// ---------------------------------------------------------------------------

describe('recent_turns', () => {
  it('returns recentTurns on a prompt_submit event', async () => {
    const reg = freshRegistry();
    const ctx = createTestCtx({
      kind: 'prompt_submit',
      prompt: 'next',
      recentTurns: 'User: a\n\nAssistant: b',
    });

    expect(await reg.call('recent_turns', {}, ctx)).toEqual(ok('User: a\n\nAssistant: b'));
  });

  it('returns ok(null) on a prompt_submit event without recentTurns', async () => {
    const reg = freshRegistry();
    const ctx = createTestCtx({ kind: 'prompt_submit', prompt: 'next' });

    expect(await reg.call('recent_turns', {}, ctx)).toEqual(ok(null));
  });

  it('returns ok(null) on a stop event (wrong kind)', async () => {
    const reg = freshRegistry();
    const ctx = createTestCtx({ kind: 'stop', assistantText: 'hi' });

    expect(await reg.call('recent_turns', {}, ctx)).toEqual(ok(null));
  });
});

// ---------------------------------------------------------------------------
// match_command — regex against tool_args.command by default, with
// invalid-regex + wrong-kind + custom-target coverage.
// ---------------------------------------------------------------------------

describe('match_command', () => {
  it('returns ok(true) when the pattern matches the command', async () => {
    const reg = freshRegistry();
    const ctx = createTestCtx({
      kind: 'tool_call',
      tool: 'Bash',
      args: { command: 'git commit --amend -m foo' },
    });

    const result = await reg.call('match_command', { pattern: 'git\\s+commit.*--amend' }, ctx);

    expect(result).toEqual(ok(true));
  });

  it('returns ok(false) when the pattern does not match', async () => {
    const reg = freshRegistry();
    const ctx = createTestCtx({
      kind: 'tool_call',
      tool: 'Bash',
      args: { command: 'git status' },
    });

    const result = await reg.call('match_command', { pattern: 'git\\s+commit.*--amend' }, ctx);

    expect(result).toEqual(ok(false));
  });

  it('returns ok(false) on a non-tool_call event', async () => {
    const reg = freshRegistry();
    const ctx = createTestCtx({ kind: 'prompt_submit', prompt: 'hi' });

    const result = await reg.call('match_command', { pattern: 'anything' }, ctx);

    expect(result).toEqual(ok(false));
  });

  it('returns err(arg_invalid) on an unclosed-group regex', async () => {
    const reg = freshRegistry();
    const ctx = createTestCtx({
      kind: 'tool_call',
      tool: 'Bash',
      args: { command: 'git status' },
    });

    const result = await reg.call('match_command', { pattern: '(unclosed' }, ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('arg_invalid');
      expect(result.error.message).toContain('(unclosed');
    }
  });

  it('reads a custom target field via tool_args.<name>', async () => {
    const reg = freshRegistry();
    const ctx = createTestCtx({
      kind: 'tool_call',
      tool: 'Bash',
      args: { command: 'git status', description: 'show git status' },
    });

    const result = await reg.call(
      'match_command',
      { pattern: 'show\\s+git', target: 'tool_args.description' },
      ctx,
    );

    expect(result).toEqual(ok(true));
  });

  it('returns ok(false) when the targeted field is missing', async () => {
    const reg = freshRegistry();
    const ctx = createTestCtx({
      kind: 'tool_call',
      tool: 'Bash',
      args: {},
    });

    const result = await reg.call('match_command', { pattern: 'anything' }, ctx);

    expect(result).toEqual(ok(false));
  });
});

// ---------------------------------------------------------------------------
// command_invokes — structural git-invocation predicate (GM.2, wg-52e57e2ed252).
// Replaces the raw-string git matchers: no false-fire on `git commit` inside a
// grep pattern / echo arg / quoted subprocess prompt; matches a real invocation.
// ---------------------------------------------------------------------------

describe('command_invokes', () => {
  const bash = (command: string): Event => ({ kind: 'tool_call', tool: 'Bash', args: { command } });

  it('matches a real compound git commit', async () => {
    const reg = freshRegistry();
    const ctx = createTestCtx(bash('cd x && git commit -m "y"'));
    expect(
      await reg.call('command_invokes', { program: 'git', subcommand: 'commit' }, ctx),
    ).toEqual(ok(true));
  });

  it('does NOT match git commit inside a grep pattern (the false-fire)', async () => {
    const reg = freshRegistry();
    const ctx = createTestCtx(bash('grep -n "git commit" file'));
    expect(
      await reg.call('command_invokes', { program: 'git', subcommand: 'commit' }, ctx),
    ).toEqual(ok(false));
  });

  it('does NOT match git commit inside a quoted subprocess prompt', async () => {
    const reg = freshRegistry();
    const ctx = createTestCtx(bash('claude -p "do a git commit thing"'));
    expect(
      await reg.call('command_invokes', { program: 'git', subcommand: 'commit' }, ctx),
    ).toEqual(ok(false));
  });

  it('matches a verify-skip flag inside a real commit', async () => {
    const reg = freshRegistry();
    const ctx = createTestCtx(bash('git commit -n'));
    expect(
      await reg.call(
        'command_invokes',
        { program: 'git', subcommand: 'commit', flag_any: ['--no-verify', '-n'] },
        ctx,
      ),
    ).toEqual(ok(true));
  });

  it('returns ok(false) on a non-tool_call event', async () => {
    const reg = freshRegistry();
    const ctx = createTestCtx({ kind: 'prompt_submit', prompt: 'git commit' });
    expect(
      await reg.call('command_invokes', { program: 'git', subcommand: 'commit' }, ctx),
    ).toEqual(ok(false));
  });

  it('returns ok(false) when the command field is missing', async () => {
    const reg = freshRegistry();
    const ctx = createTestCtx({ kind: 'tool_call', tool: 'Bash', args: {} });
    expect(
      await reg.call('command_invokes', { program: 'git', subcommand: 'commit' }, ctx),
    ).toEqual(ok(false));
  });

  it('returns err(arg_invalid) on an unexpected arg key (.strict())', async () => {
    const reg = freshRegistry();
    const ctx = createTestCtx(bash('git commit'));
    const result = await reg.call('command_invokes', { program: 'git', bogus: 1 }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('arg_invalid');
  });
});
