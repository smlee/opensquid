/**
 * Process-evaluator tests — Task 1.3.
 *
 * Per spec: ≥ 6 cases covering happy path, `if` true/false, `on_empty`,
 * missing function, interpolation, terminal verdict, plus two bonus cases
 * (on_empty: 'block' and simple-equality conditions).
 *
 * Each test builds its own FunctionRegistry and EvalCtx so bindings never
 * leak between cases (per Task 1.3 risk callout: bindings mutate via `as:`).
 */

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { FunctionRegistry, type EvalCtx, type FunctionDef } from '../functions/registry.js';

import { evaluateProcess } from './evaluator.js';
import { err, ok } from './result.js';
import type { Event, ProcessStep } from './types.js';

// ---------------------------------------------------------------------------
// Test helper — fresh EvalCtx per case. Mirrors registry.test.ts shape so
// future primitive tests can converge on a shared helper (Task 1.4+).
// ---------------------------------------------------------------------------

function createTestCtx(overrides: Partial<EvalCtx> = {}): EvalCtx {
  const event: Event = { kind: 'stop', assistantText: '' };
  return {
    event,
    bindings: new Map<string, unknown>(),
    sessionId: 'test-session',
    packId: 'test-pack',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Reusable primitive defs. Kept minimal — each test composes only what it
// needs against a fresh registry.
// ---------------------------------------------------------------------------

const verdictDef: FunctionDef<{ level: string; message: string }, unknown> = {
  name: 'verdict',
  argSchema: z.object({ level: z.string(), message: z.string() }),
  execute: (args) => Promise.resolve(ok({ level: args.level, message: args.message })),
};

const setTrueDef: FunctionDef<Record<string, never>, boolean> = {
  name: 'set_true',
  argSchema: z.object({}),
  execute: () => Promise.resolve(ok(true)),
};

const setFalseDef: FunctionDef<Record<string, never>, boolean> = {
  name: 'set_false',
  argSchema: z.object({}),
  execute: () => Promise.resolve(ok(false)),
};

const emptyArrayDef: FunctionDef<Record<string, never>, unknown[]> = {
  name: 'empty_array',
  argSchema: z.object({}),
  execute: () => Promise.resolve(ok([])),
};

// A primitive that always fails — mirrors a `subagent_call` that could not
// spawn (FunctionError kind 'runtime'). Used for the `on_error` policy tests.
const boomDef: FunctionDef<Record<string, never>, never> = {
  name: 'boom',
  argSchema: z.object({}),
  execute: () => Promise.resolve(err({ kind: 'runtime', message: 'spawn refused' })),
};

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe('evaluateProcess — terminal verdict', () => {
  it('returns the verdict when `verdict` primitive yields a Verdict shape', async () => {
    const reg = new FunctionRegistry();
    reg.register(verdictDef);

    const steps: ProcessStep[] = [{ call: 'verdict', args: { level: 'block', message: 'no' } }];

    const result = await evaluateProcess(steps, createTestCtx(), reg);

    expect(result).toEqual({
      kind: 'verdict',
      verdict: { level: 'block', message: 'no' },
    });
  });
});

describe('evaluateProcess — conditional steps via `if`', () => {
  it('runs the second step when the bound `hit` is truthy', async () => {
    const reg = new FunctionRegistry();
    reg.register(setTrueDef);
    reg.register(verdictDef);

    const steps: ProcessStep[] = [
      { call: 'set_true', as: 'hit' },
      {
        call: 'verdict',
        if: 'hit',
        args: { level: 'warn', message: 'fired' },
      },
    ];

    const result = await evaluateProcess(steps, createTestCtx(), reg);

    expect(result).toEqual({
      kind: 'verdict',
      verdict: { level: 'warn', message: 'fired' },
    });
  });

  it('skips the second step when `hit` is falsy and ends with no_verdict', async () => {
    const reg = new FunctionRegistry();
    reg.register(setFalseDef);
    reg.register(verdictDef);

    const steps: ProcessStep[] = [
      { call: 'set_false', as: 'hit' },
      {
        call: 'verdict',
        if: 'hit',
        args: { level: 'block', message: 'should not run' },
      },
    ];

    const result = await evaluateProcess(steps, createTestCtx(), reg);

    expect(result).toEqual({ kind: 'no_verdict' });
  });
});

describe('evaluateProcess — on_empty policy', () => {
  it("on_empty: 'pass' early-exits with no_verdict when result is empty", async () => {
    const reg = new FunctionRegistry();
    reg.register(emptyArrayDef);
    reg.register(verdictDef);

    const steps: ProcessStep[] = [
      { call: 'empty_array', on_empty: 'pass' },
      {
        call: 'verdict',
        args: { level: 'block', message: 'unreachable' },
      },
    ];

    const result = await evaluateProcess(steps, createTestCtx(), reg);

    expect(result).toEqual({ kind: 'no_verdict' });
  });

  it("on_empty: 'block' returns an auto-generated block verdict", async () => {
    const reg = new FunctionRegistry();
    reg.register(emptyArrayDef);

    const steps: ProcessStep[] = [{ call: 'empty_array', on_empty: 'block' }];

    const result = await evaluateProcess(steps, createTestCtx(), reg);

    expect(result).toEqual({
      kind: 'verdict',
      verdict: { level: 'block', message: 'Step 0 returned empty' },
    });
  });
});

describe('evaluateProcess — error surfacing', () => {
  it('returns kind: error with the failing step index when the function is missing', async () => {
    const reg = new FunctionRegistry();

    const steps: ProcessStep[] = [{ call: 'foo' }];

    const result = await evaluateProcess(steps, createTestCtx(), reg);

    expect(result.kind).toBe('error');
    if (result.kind !== 'error') throw new Error('unreachable');
    expect(result.step).toBe(0);
    expect(result.error).toContain('foo');
  });

  it("a failing primitive WITHOUT on_error aborts with kind: error (default 'abort')", async () => {
    const reg = new FunctionRegistry();
    reg.register(boomDef);
    reg.register(verdictDef);

    const steps: ProcessStep[] = [
      { call: 'boom', as: 'x' },
      { call: 'verdict', args: { level: 'warn', message: 'unreachable' } },
    ];

    const result = await evaluateProcess(steps, createTestCtx(), reg);

    expect(result.kind).toBe('error');
    if (result.kind !== 'error') throw new Error('unreachable');
    expect(result.step).toBe(0);
    expect(result.error).toContain('spawn refused');
  });

  it("on_error: 'abort' is explicit-equivalent to the default", async () => {
    const reg = new FunctionRegistry();
    reg.register(boomDef);

    const steps: ProcessStep[] = [{ call: 'boom', on_error: 'abort' }];

    const result = await evaluateProcess(steps, createTestCtx(), reg);

    expect(result.kind).toBe('error');
  });

  it("on_error: 'continue' binds the error message to `as` and proceeds to the next step", async () => {
    const reg = new FunctionRegistry();
    reg.register(boomDef);
    reg.register(verdictDef);

    const ctx = createTestCtx();
    const steps: ProcessStep[] = [
      { call: 'boom', as: 'audit', on_error: 'continue' },
      {
        call: 'verdict',
        // The bound error message is reachable in a downstream `if:` —
        // here we simply assert the rule REACHES a terminal verdict (it did
        // not abort) and the binding carries the error text.
        if: 'contains(audit, "spawn refused")',
        args: { level: 'block', message: 'audit unavailable' },
      },
    ];

    const result = await evaluateProcess(steps, ctx, reg);

    expect(result).toEqual({
      kind: 'verdict',
      verdict: { level: 'block', message: 'audit unavailable' },
    });
    expect(ctx.bindings.get('audit')).toBe('spawn refused');
  });

  it("on_error: 'continue' without `as` still proceeds (no binding written)", async () => {
    const reg = new FunctionRegistry();
    reg.register(boomDef);
    reg.register(verdictDef);

    const ctx = createTestCtx();
    const steps: ProcessStep[] = [
      { call: 'boom', on_error: 'continue' },
      { call: 'verdict', args: { level: 'warn', message: 'reached' } },
    ];

    const result = await evaluateProcess(steps, ctx, reg);

    expect(result).toEqual({
      kind: 'verdict',
      verdict: { level: 'warn', message: 'reached' },
    });
  });
});

describe('evaluateProcess — `{{var}}` interpolation', () => {
  it('substitutes bound variables into string args and empty-strings unbound vars', async () => {
    const captured: Record<string, unknown>[] = [];

    const captureDef: FunctionDef<{ msg: string; missing: string }, string> = {
      name: 'capture',
      argSchema: z.object({ msg: z.string(), missing: z.string() }),
      execute: (args) => {
        captured.push({ ...args });
        return Promise.resolve(ok(args.msg));
      },
    };

    const reg = new FunctionRegistry();
    reg.register(setTrueDef);
    reg.register(captureDef);

    // Use a primitive that binds a string into `name`.
    const stringBindDef: FunctionDef<Record<string, never>, string> = {
      name: 'bind_name',
      argSchema: z.object({}),
      execute: () => Promise.resolve(ok('world')),
    };
    reg.register(stringBindDef);

    const steps: ProcessStep[] = [
      { call: 'bind_name', as: 'name' },
      {
        call: 'capture',
        args: { msg: 'hello {{name}}', missing: 'pre-{{nope}}-post' },
      },
    ];

    const result = await evaluateProcess(steps, createTestCtx(), reg);

    expect(result).toEqual({ kind: 'no_verdict' });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual({
      msg: 'hello world',
      missing: 'pre--post',
    });
  });

  it('resolves a dotted path into a bound object ({{obj.field}}) + empty-strings a missing path', async () => {
    const captured: Record<string, unknown>[] = [];
    const captureDef: FunctionDef<{ path: string; deep: string; nope: string }, string> = {
      name: 'capture2',
      argSchema: z.object({ path: z.string(), deep: z.string(), nope: z.string() }),
      execute: (args) => {
        captured.push({ ...args });
        return Promise.resolve(ok(''));
      },
    };
    const bindObj: FunctionDef<
      Record<string, never>,
      { file_path: string; meta: { id: string } }
    > = {
      name: 'bind_obj',
      argSchema: z.object({}),
      execute: () => Promise.resolve(ok({ file_path: 'src/x.ts', meta: { id: 'T-1' } })),
    };
    const reg = new FunctionRegistry();
    reg.register(captureDef);
    reg.register(bindObj);

    const steps: ProcessStep[] = [
      { call: 'bind_obj', as: 'targs' },
      {
        call: 'capture2',
        args: {
          path: '{{targs.file_path}}',
          deep: 'id={{targs.meta.id}}',
          nope: 'x-{{targs.missing.deeper}}-y',
        },
      },
    ];
    await evaluateProcess(steps, createTestCtx(), reg);
    expect(captured[0]).toEqual({ path: 'src/x.ts', deep: 'id=T-1', nope: 'x--y' });
  });

  it('interpolates templates NESTED inside object/array args', async () => {
    const captured: Record<string, unknown>[] = [];
    const captureDef: FunctionDef<Record<string, unknown>, string> = {
      name: 'capture3',
      argSchema: z.record(z.unknown()),
      execute: (args) => {
        captured.push({ ...args });
        return Promise.resolve(ok(''));
      },
    };
    const bindStr: FunctionDef<Record<string, never>, string> = {
      name: 'bind_path',
      argSchema: z.object({}),
      execute: () => Promise.resolve(ok('docs/research/x-pre-research.md')),
    };
    const reg = new FunctionRegistry();
    reg.register(captureDef);
    reg.register(bindStr);

    const steps: ProcessStep[] = [
      { call: 'bind_path', as: 'prp' },
      {
        call: 'capture3',
        args: { next_action: { profession: 'task-spec-author', args: { path: '{{prp}}' } } },
      },
    ];
    await evaluateProcess(steps, createTestCtx(), reg);
    expect(captured[0]).toEqual({
      next_action: {
        profession: 'task-spec-author',
        args: { path: 'docs/research/x-pre-research.md' },
      },
    });
  });
});

describe('evaluateProcess — simple equality in `if`', () => {
  it('runs the step when `x == "FOO"` matches the bound value', async () => {
    const reg = new FunctionRegistry();
    const bindFoo: FunctionDef<Record<string, never>, string> = {
      name: 'bind_foo',
      argSchema: z.object({}),
      execute: () => Promise.resolve(ok('FOO')),
    };
    reg.register(bindFoo);
    reg.register(verdictDef);

    const steps: ProcessStep[] = [
      { call: 'bind_foo', as: 'x' },
      {
        call: 'verdict',
        if: 'x == "FOO"',
        args: { level: 'warn', message: 'matched' },
      },
    ];

    const result = await evaluateProcess(steps, createTestCtx(), reg);

    expect(result).toEqual({
      kind: 'verdict',
      verdict: { level: 'warn', message: 'matched' },
    });
  });

  it('skips the step when `x == "BAR"` does not match the bound value', async () => {
    const reg = new FunctionRegistry();
    const bindFoo: FunctionDef<Record<string, never>, string> = {
      name: 'bind_foo',
      argSchema: z.object({}),
      execute: () => Promise.resolve(ok('FOO')),
    };
    reg.register(bindFoo);
    reg.register(verdictDef);

    const steps: ProcessStep[] = [
      { call: 'bind_foo', as: 'x' },
      {
        call: 'verdict',
        if: 'x == "BAR"',
        args: { level: 'warn', message: 'should-skip' },
      },
    ];

    const result = await evaluateProcess(steps, createTestCtx(), reg);

    expect(result).toEqual({ kind: 'no_verdict' });
  });
});

describe('evaluateProcess — unsupported if-expression', () => {
  it('warns and treats unsupported expressions as false', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const reg = new FunctionRegistry();
      reg.register(verdictDef);

      const steps: ProcessStep[] = [
        {
          call: 'verdict',
          // H.1.6: `||` is now valid grammar (was unsupported pre-cutover).
          // Use truly-invalid syntax (`== =` — a bare `=` is not a recognised
          // lexer token; only `==` / `===` / `!=` / `!==` consume `=`) to
          // exercise the lex-error → false-with-warn path. Pre-research §7.1
          // case #5 marks this as the one justified test-code rewrite of
          // the H.1.6 cutover.
          if: '== =',
          args: { level: 'block', message: 'should-skip' },
        },
      ];

      const result = await evaluateProcess(steps, createTestCtx(), reg);

      expect(result).toEqual({ kind: 'no_verdict' });
      // The chevrotain-backed evaluator emits a warn prefixed with
      // `[opensquid:evaluator]` and naming the error tier (lex / parse /
      // runtime / interpreter-limit). Filter to that prefix so the registry's
      // own `durable`-flag warning doesn't bleed into the assertion.
      const ifWarnings = warn.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('[opensquid:evaluator]'),
      );
      expect(ifWarnings.length).toBeGreaterThanOrEqual(1);
    } finally {
      warn.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// G.5 — extended if-expression forms: numeric-property comparison + AND.
// These tests pin the `verify-before-citing-memory` skill's exact YAML
// expression shape (`drift_phrases.matched.length > 0 && verification_tools
// .count === 0`) to the deterministic, no-eval evaluator.
// ---------------------------------------------------------------------------

describe('evaluateProcess — G.5 extended if-expressions', () => {
  function makeBindingEmitter(bindings: Record<string, unknown>): FunctionRegistry {
    const reg = new FunctionRegistry();
    reg.register(verdictDef);
    for (const [name, value] of Object.entries(bindings)) {
      reg.register({
        name: `emit_${name}`,
        argSchema: z.record(z.unknown()),
        durable: false,
        memoizable: false,
        // eslint-disable-next-line @typescript-eslint/require-await -- async to match contract
        execute: async () => ok(value),
      });
    }
    return reg;
  }

  it('name.length > 0 evaluates against a bound array', async () => {
    const reg = makeBindingEmitter({ matches: ['per memory', 'deferred'] });
    const steps: ProcessStep[] = [
      { call: 'emit_matches', as: 'matches' },
      {
        call: 'verdict',
        if: 'matches.length > 0',
        args: { level: 'warn', message: 'matched' },
      },
    ];
    const result = await evaluateProcess(steps, createTestCtx(), reg);
    expect(result).toEqual({ kind: 'verdict', verdict: { level: 'warn', message: 'matched' } });
  });

  it('name.length > 0 is false on an empty array (verdict skipped)', async () => {
    const reg = makeBindingEmitter({ matches: [] });
    const steps: ProcessStep[] = [
      { call: 'emit_matches', as: 'matches' },
      {
        call: 'verdict',
        if: 'matches.length > 0',
        args: { level: 'warn', message: 'should-skip' },
      },
    ];
    const result = await evaluateProcess(steps, createTestCtx(), reg);
    expect(result).toEqual({ kind: 'no_verdict' });
  });

  it('name.count === 0 evaluates against an object field', async () => {
    const reg = makeBindingEmitter({ tools: { tools: [], count: 0 } });
    const steps: ProcessStep[] = [
      { call: 'emit_tools', as: 'tools' },
      {
        call: 'verdict',
        if: 'tools.count === 0',
        args: { level: 'warn', message: 'no-tools' },
      },
    ];
    const result = await evaluateProcess(steps, createTestCtx(), reg);
    expect(result).toEqual({ kind: 'verdict', verdict: { level: 'warn', message: 'no-tools' } });
  });

  it('nested name.field.subfield resolves through one intermediate segment', async () => {
    const reg = makeBindingEmitter({
      drift: { matched: ['per memory', 'deferred'] },
    });
    const steps: ProcessStep[] = [
      { call: 'emit_drift', as: 'drift' },
      {
        call: 'verdict',
        if: 'drift.matched.length > 0',
        args: { level: 'warn', message: 'nested-fired' },
      },
    ];
    const result = await evaluateProcess(steps, createTestCtx(), reg);
    expect(result).toEqual({
      kind: 'verdict',
      verdict: { level: 'warn', message: 'nested-fired' },
    });
  });

  it('compound A && B with nested + flat paths fires when both are true', async () => {
    // Exact shape used by G.5's verify-before-citing-memory skill.
    const reg = makeBindingEmitter({
      drift_phrases: {
        matched: ['per memory'],
        phrases: [{ phrase: 'per memory', offset: 0 }],
      },
      verification_tools: { tools: [], count: 0 },
    });
    const steps: ProcessStep[] = [
      { call: 'emit_drift_phrases', as: 'drift_phrases' },
      { call: 'emit_verification_tools', as: 'verification_tools' },
      {
        call: 'verdict',
        if: 'drift_phrases.matched.length > 0 && verification_tools.count === 0',
        args: { level: 'warn', message: 'compound-fired' },
      },
    ];
    const result = await evaluateProcess(steps, createTestCtx(), reg);
    expect(result).toEqual({
      kind: 'verdict',
      verdict: { level: 'warn', message: 'compound-fired' },
    });
  });

  it('compound A && B short-circuits to no-verdict when LHS is false', async () => {
    const reg = makeBindingEmitter({
      drift_phrases: { matched: [], phrases: [] },
      verification_tools: { tools: [], count: 0 },
    });
    const steps: ProcessStep[] = [
      { call: 'emit_drift_phrases', as: 'drift_phrases' },
      { call: 'emit_verification_tools', as: 'verification_tools' },
      {
        call: 'verdict',
        if: 'drift_phrases.matched.length > 0 && verification_tools.count === 0',
        args: { level: 'warn', message: 'should-skip' },
      },
    ];
    const result = await evaluateProcess(steps, createTestCtx(), reg);
    expect(result).toEqual({ kind: 'no_verdict' });
  });

  it('compound A && B short-circuits to no-verdict when RHS is false', async () => {
    const reg = makeBindingEmitter({
      drift_phrases: { matched: ['per memory'], phrases: [] },
      verification_tools: { tools: ['Read'], count: 1 },
    });
    const steps: ProcessStep[] = [
      { call: 'emit_drift_phrases', as: 'drift_phrases' },
      { call: 'emit_verification_tools', as: 'verification_tools' },
      {
        call: 'verdict',
        if: 'drift_phrases.matched.length > 0 && verification_tools.count === 0',
        args: { level: 'warn', message: 'should-skip' },
      },
    ];
    const result = await evaluateProcess(steps, createTestCtx(), reg);
    expect(result).toEqual({ kind: 'no_verdict' });
  });
});
