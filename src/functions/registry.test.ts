/**
 * Registration + dispatch tests for the function-library registry.
 *
 * Per Task 1.2 acceptance criteria: ≥ 5 cases covering register/call success,
 * duplicate-register throw, not_found, arg_invalid, and list/has/get
 * introspection. Includes a `createTestCtx` helper so primitive tests don't
 * repeat boilerplate.
 */

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { ok } from '../runtime/result.js';
import type { Event } from '../runtime/types.js';

import { type EvalCtx, type FunctionDef, FunctionRegistry } from './registry.js';

// ---------------------------------------------------------------------------
// Test helper: build an EvalCtx with sensible defaults.
//
// Per Task 1.2 step 7 (fix): EvalCtx is awkward to construct ad-hoc, so
// downstream primitive tests (1.4+) will reuse this helper.
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
// Dummy `add` primitive — used across the suite.
// ---------------------------------------------------------------------------

const addDef: FunctionDef<{ a: number; b: number }, number> = {
  name: 'add',
  argSchema: z.object({ a: z.number(), b: z.number() }),
  execute: (args) => Promise.resolve(ok(args.a + args.b)),
};

describe('FunctionRegistry.register + call', () => {
  it('dispatches a registered primitive with validated args', async () => {
    const reg = new FunctionRegistry();
    reg.register(addDef);

    const result = await reg.call('add', { a: 1, b: 2 }, createTestCtx());

    expect(result).toEqual({ ok: true, value: 3 });
  });

  it('throws on duplicate registration', () => {
    const reg = new FunctionRegistry();
    reg.register(addDef);

    expect(() => reg.register(addDef)).toThrow(/already registered/);
    expect(() => reg.register(addDef)).toThrow(/"add"/);
  });

  it('returns not_found Err for an unregistered name', async () => {
    const reg = new FunctionRegistry();

    const result = await reg.call('missing', {}, createTestCtx());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('not_found');
    expect(result.error.message).toContain('missing');
  });

  it('returns arg_invalid Err with the ZodError as cause', async () => {
    const reg = new FunctionRegistry();
    reg.register(addDef);

    const result = await reg.call('add', { a: 'one', b: 2 }, createTestCtx());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('arg_invalid');
    expect(result.error.message).toContain('add');
    expect(result.error.cause).toBeInstanceOf(z.ZodError);
  });
});

describe('FunctionRegistry introspection', () => {
  it('list() returns sorted names; has() / get() agree with registration', () => {
    const reg = new FunctionRegistry();
    reg.register(addDef);
    reg.register({
      name: 'noop',
      argSchema: z.object({}),
      execute: () => Promise.resolve(ok(undefined)),
    });

    expect(reg.list()).toEqual(['add', 'noop']);
    expect(reg.has('add')).toBe(true);
    expect(reg.has('noop')).toBe(true);
    expect(reg.has('missing')).toBe(false);

    expect(reg.get('add')?.name).toBe('add');
    expect(reg.get('missing')).toBeUndefined();
  });

  it('supports primitives that bind no value via ok(undefined)', async () => {
    const reg = new FunctionRegistry();
    reg.register({
      name: 'side_effect',
      argSchema: z.object({}),
      execute: (_args, ctx) => {
        ctx.bindings.set('touched', true);
        return Promise.resolve(ok(undefined));
      },
    });

    const ctx = createTestCtx();
    const result = await reg.call('side_effect', {}, ctx);

    expect(result).toEqual({ ok: true, value: undefined });
    expect(ctx.bindings.get('touched')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DURABLE.2 — durability metadata on FunctionDef.
//
// Coverage:
//   1. `durability()` returns normalized flags for explicit declarations.
//   2. `durability()` returns `false`/`undefined` defaults for omissions.
//   3. Registry emits a console.warn when `durable` is omitted at register().
//   4. Registry does NOT warn when `durable` is explicitly set (true OR false).
//   5. `durability()` returns `undefined` for unregistered names.
// ---------------------------------------------------------------------------

describe('FunctionRegistry durability metadata (DURABLE.2)', () => {
  it('returns normalized durability flags for explicit declarations', () => {
    const reg = new FunctionRegistry();
    reg.register({
      name: 'llm_classify',
      argSchema: z.object({}),
      execute: () => Promise.resolve(ok(null)),
      durable: true,
      memoizable: true,
      costEstimateMs: 3000,
    });

    expect(reg.durability('llm_classify')).toEqual({
      durable: true,
      memoizable: true,
      costEstimateMs: 3000,
    });
  });

  it('defaults durable/memoizable to false when omitted', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const reg = new FunctionRegistry();
      reg.register({
        name: 'lazy',
        argSchema: z.object({}),
        execute: () => Promise.resolve(ok(null)),
      });

      expect(reg.durability('lazy')).toEqual({
        durable: false,
        memoizable: false,
        costEstimateMs: undefined,
      });
    } finally {
      warn.mockRestore();
    }
  });

  it('emits a console.warn when a primitive registers without `durable`', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const reg = new FunctionRegistry();
      reg.register({
        name: 'forgot_flag',
        argSchema: z.object({}),
        execute: () => Promise.resolve(ok(null)),
      });

      expect(warn).toHaveBeenCalledTimes(1);
      const msg: unknown = warn.mock.calls[0]?.[0];
      expect(typeof msg === 'string' && msg.includes('forgot_flag')).toBe(true);
      expect(typeof msg === 'string' && msg.includes('durable')).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('does NOT warn when `durable` is set explicitly (true or false)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const reg = new FunctionRegistry();
      reg.register({
        name: 'cheap',
        argSchema: z.object({}),
        execute: () => Promise.resolve(ok(null)),
        durable: false,
        memoizable: false,
        costEstimateMs: 0.1,
      });
      reg.register({
        name: 'expensive',
        argSchema: z.object({}),
        execute: () => Promise.resolve(ok(null)),
        durable: true,
        memoizable: true,
        costEstimateMs: 3000,
      });

      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('returns undefined for an unregistered primitive', () => {
    const reg = new FunctionRegistry();
    expect(reg.durability('missing')).toBeUndefined();
  });
});
