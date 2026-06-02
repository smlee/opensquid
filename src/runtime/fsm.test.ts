/**
 * T-PACK-FSM-STANDARDIZATION slice A — FSM engine tests.
 *
 * Covers the engine (validation + the total `step` function) and a PARITY proof
 * that the workflow FSM reproduces `chain_state`'s forward pipeline AND gains
 * the loop-back edge `chain_state` structurally cannot express.
 */
import { describe, expect, it } from 'vitest';

import { Fsm, validateFsm, step, ANY_STATE } from './fsm.js';
import { WORKFLOW_FSM } from './workflow_fsm.js';
import { CHAIN_STAGES } from './chain_state.js';

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

describe('WORKFLOW_FSM — parity with chain_state + the loop-back it lacks', () => {
  it('is valid + its states are exactly CHAIN_STAGES in order', () => {
    expect(validateFsm(WORKFLOW_FSM)).toEqual([]);
    expect(WORKFLOW_FSM.states).toEqual([...CHAIN_STAGES]);
    expect(WORKFLOW_FSM.initial).toBe('idle');
  });

  it('drives the forward pipeline idle → … → phases_complete', () => {
    const path: [string, string][] = [
      ['idle', 'scope_start'],
      ['scoping', 'research_done'],
      ['researched', 'spec_authored'],
      ['spec_authored', 'tasks_loaded'],
      ['tasks_loaded', 'phase_started'],
      ['phases_in_flight', 'phases_done'],
    ];
    let state = WORKFLOW_FSM.initial;
    for (const [expectedState, event] of path) {
      expect(state).toBe(expectedState);
      state = step(WORKFLOW_FSM, state, event).next;
    }
    expect(state).toBe('phases_complete');
  });

  it('LOOP-BACK: researched --guess_found--> scoping (the edge chain_state cannot express)', () => {
    expect(step(WORKFLOW_FSM, 'researched', 'guess_found')).toMatchObject({
      next: 'scoping',
      transitioned: true,
    });
  });
});
