/**
 * Registration + dispatch tests for the function-library registry.
 *
 * Per Task 1.2 acceptance criteria: ≥ 5 cases covering register/call success,
 * duplicate-register throw, not_found, arg_invalid, and list/has/get
 * introspection. Includes a `createTestCtx` helper so primitive tests don't
 * repeat boilerplate.
 */

import { describe, expect, it } from 'vitest';
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
