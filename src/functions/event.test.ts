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
