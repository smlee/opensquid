/**
 * T-PACK-FSM-STANDARDIZATION slice A3b — read_fsm_state / advance_fsm tests.
 *
 * Drives the primitives through the registry (the real call path), with the
 * pack's FSM threaded as ctx.packFsm exactly as the dispatcher does.
 */
import { describe, expect, it } from 'vitest';

import type { Fsm } from '../runtime/fsm.js';
import type { Event } from '../runtime/types.js';

import { registerFsmFunctions } from './fsm.js';
import { type EvalCtx, FunctionRegistry } from './registry.js';

const FSM: Fsm = {
  initial: 'idle',
  states: ['idle', 'researching', 'building'],
  transitions: [
    { from: 'idle', on: 'start', to: 'researching' },
    { from: 'researching', on: 'go', to: 'building', when: 'ok' },
  ],
};

let n = 0;
function ctx(withFsm: boolean): EvalCtx {
  const event: Event = { kind: 'stop', assistantText: '' };
  const base: EvalCtx = {
    event,
    bindings: new Map<string, unknown>(),
    sessionId: `fsm-fn-${String(n++)}`,
    packId: 'p',
  };
  return withFsm ? { ...base, packFsm: FSM } : base;
}

function reg(): FunctionRegistry {
  const r = new FunctionRegistry();
  registerFsmFunctions(r);
  return r;
}

async function callValue(
  r: FunctionRegistry,
  name: string,
  args: unknown,
  c: EvalCtx,
): Promise<unknown> {
  const res = await r.call(name, args, c);
  if (!res.ok) throw new Error(`call ${name} failed: ${res.error.message}`);
  return res.value;
}

describe('read_fsm_state / advance_fsm', () => {
  it('read_fsm_state returns the initial state before any advance', async () => {
    expect(await callValue(reg(), 'read_fsm_state', {}, ctx(true))).toBe('idle');
  });

  it('advance_fsm moves along a declared transition + persists', async () => {
    const r = reg();
    const c = ctx(true);
    expect(await callValue(r, 'advance_fsm', { event: 'start' }, c)).toBe('researching');
    expect(await callValue(r, 'read_fsm_state', {}, c)).toBe('researching');
  });

  it('advance_fsm honors a `when` guard via the current bindings', async () => {
    const r = reg();
    const c = ctx(true);
    await callValue(r, 'advance_fsm', { event: 'start' }, c);
    // guard `ok` absent/falsy → blocked, stays in researching
    expect(await callValue(r, 'advance_fsm', { event: 'go' }, c)).toBe('researching');
    // bind ok=true → the guard passes → advances
    c.bindings.set('ok', true);
    expect(await callValue(r, 'advance_fsm', { event: 'go' }, c)).toBe('building');
  });

  it('both no-op (null) when the pack ships no fsm', async () => {
    const r = reg();
    const c = ctx(false);
    expect(await callValue(r, 'read_fsm_state', {}, c)).toBeNull();
    expect(await callValue(r, 'advance_fsm', { event: 'start' }, c)).toBeNull();
  });

  it('advance_fsm is total: an unknown event leaves the state unchanged', async () => {
    const r = reg();
    const c = ctx(true);
    await callValue(r, 'advance_fsm', { event: 'start' }, c);
    expect(await callValue(r, 'advance_fsm', { event: 'nonsense' }, c)).toBe('researching');
  });

  it('read_fsm_state({pack}) reads ANOTHER pack lifecycle state cross-pack (null if unstarted)', async () => {
    const r = reg();
    const event = { kind: 'stop', assistantText: '' } as const;
    const sid = 'cross-pack-read';
    // pack 'p' advances to researching
    const cP: EvalCtx = { event, bindings: new Map(), sessionId: sid, packId: 'p', packFsm: FSM };
    await callValue(r, 'advance_fsm', { event: 'start' }, cP);
    // a DIFFERENT pack (no own fsm) reads p's state by name + an unstarted one → null
    const cOther: EvalCtx = { event, bindings: new Map(), sessionId: sid, packId: 'other' };
    expect(await callValue(r, 'read_fsm_state', { pack: 'p' }, cOther)).toBe('researching');
    expect(await callValue(r, 'read_fsm_state', { pack: 'unstarted' }, cOther)).toBeNull();
  });
});
