/**
 * T-PACK-FSM-STANDARDIZATION slice A — FSM engine tests.
 *
 * Covers the generic engine: load-time validation (totality) and the total
 * `step` transition function (matching transition / `*` wildcard / `when`
 * guard / self-loop / explicit stay). The concrete 7-phase workflow FSM is
 * exercised end-to-end by the `workflow-fsm` pack test.
 */
import { describe, expect, it } from 'vitest';

import { Fsm, validateFsm, step, ANY_STATE } from './fsm.js';

const TRAFFIC: Fsm = {
  initial: 'red',
  states: ['red', 'green', 'yellow'],
  transitions: [
    { from: 'red', on: 'go', to: 'green' },
    { from: 'green', on: 'caution', to: 'yellow' },
    { from: 'yellow', on: 'stop', to: 'red' },
  ],
};

describe('validateFsm', () => {
  it('accepts a well-formed machine', () => {
    expect(validateFsm(TRAFFIC)).toEqual([]);
  });

  it('rejects an initial state not in states', () => {
    const bad = Fsm.parse({ initial: 'purple', states: ['red'], transitions: [] });
    expect(validateFsm(bad)).toContainEqual(expect.stringContaining('initial state "purple"'));
  });

  it('rejects a transition targeting an undeclared state (totality)', () => {
    const bad = Fsm.parse({
      initial: 'a',
      states: ['a'],
      transitions: [{ from: 'a', on: 'x', to: 'ghost' }],
    });
    expect(validateFsm(bad)).toContainEqual(
      expect.stringContaining('to "ghost" is not a declared'),
    );
  });

  it('rejects a transition from an undeclared state (but allows the * wildcard)', () => {
    const bad = Fsm.parse({
      initial: 'a',
      states: ['a'],
      transitions: [{ from: 'b', on: 'x', to: 'a' }],
    });
    expect(validateFsm(bad)).toContainEqual(expect.stringContaining('from "b" is not a declared'));

    const ok = Fsm.parse({
      initial: 'a',
      states: ['a'],
      transitions: [{ from: ANY_STATE, on: 'reset', to: 'a' }],
    });
    expect(validateFsm(ok)).toEqual([]);
  });
});

describe('step (total transition function)', () => {
  it('takes a matching transition', () => {
    expect(step(TRAFFIC, 'red', 'go')).toEqual({ next: 'green', transitioned: true, via: 0 });
  });

  it('is TOTAL: an unknown event stays in the current state (explicit default)', () => {
    expect(step(TRAFFIC, 'red', 'caution')).toEqual({
      next: 'red',
      transitioned: false,
      via: null,
    });
  });

  it('honors a `when` guard via the injected evaluator', () => {
    const fsm: Fsm = {
      initial: 'a',
      states: ['a', 'b'],
      transitions: [{ from: 'a', on: 'maybe', to: 'b', when: 'ready' }],
    };
    expect(step(fsm, 'a', 'maybe', () => false)).toMatchObject({ next: 'a', transitioned: false });
    expect(step(fsm, 'a', 'maybe', () => true)).toMatchObject({ next: 'b', transitioned: true });
  });

  it('a `*` (any) transition fires from any state', () => {
    const fsm: Fsm = {
      initial: 'a',
      states: ['a', 'b', 'done'],
      transitions: [{ from: ANY_STATE, on: 'abort', to: 'done' }],
    };
    expect(step(fsm, 'a', 'abort').next).toBe('done');
    expect(step(fsm, 'b', 'abort').next).toBe('done');
  });

  it('a self-loop transition stays but is reported as not-transitioned', () => {
    const fsm: Fsm = {
      initial: 'r',
      states: ['r'],
      transitions: [{ from: 'r', on: 'again', to: 'r' }],
    };
    expect(step(fsm, 'r', 'again')).toEqual({ next: 'r', transitioned: false, via: 0 });
  });
});
