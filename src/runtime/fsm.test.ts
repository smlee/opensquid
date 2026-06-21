/**
 * FSM engine tests — T-PACK-FSM-STANDARDIZATION slice A (flat wire) + T-harel-full HAR.0 (tree).
 *
 * Two layers:
 *  - WIRE (flat): validateFsm + stepFlat — the degenerate-tree path; every pre-HAR.0 case
 *    behaves byte-identically (parity).
 *  - RUNTIME (tree): validateStatechart + step over a Configuration — compound/LCCA/parallel,
 *    totality over configurations.
 */
import { describe, expect, it } from 'vitest';

import {
  Fsm,
  validateFsm,
  stepFlat,
  step,
  validateStatechart,
  initialConfig,
  ANY_STATE,
  type Statechart,
} from './fsm.js';

const TRAFFIC: Fsm = {
  initial: 'red',
  states: ['red', 'green', 'yellow'],
  transitions: [
    { from: 'red', on: 'go', to: 'green' },
    { from: 'green', on: 'caution', to: 'yellow' },
    { from: 'yellow', on: 'stop', to: 'red' },
  ],
};

describe('validateFsm (flat wire)', () => {
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

describe('stepFlat (degenerate-tree parity — the pre-HAR.0 contract)', () => {
  it('takes a matching transition', () => {
    expect(stepFlat(TRAFFIC, 'red', 'go')).toEqual({ next: 'green', transitioned: true, via: 0 });
  });

  it('is TOTAL: an unknown event stays in the current state (explicit default)', () => {
    expect(stepFlat(TRAFFIC, 'red', 'caution')).toEqual({
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
    expect(stepFlat(fsm, 'a', 'maybe', () => false)).toMatchObject({
      next: 'a',
      transitioned: false,
    });
    expect(stepFlat(fsm, 'a', 'maybe', () => true)).toMatchObject({
      next: 'b',
      transitioned: true,
    });
  });

  it('a `*` (any) transition fires from any state', () => {
    const fsm: Fsm = {
      initial: 'a',
      states: ['a', 'b', 'done'],
      transitions: [{ from: ANY_STATE, on: 'abort', to: 'done' }],
    };
    expect(stepFlat(fsm, 'a', 'abort').next).toBe('done');
    expect(stepFlat(fsm, 'b', 'abort').next).toBe('done');
  });

  it('a self-loop transition stays but is reported as not-transitioned', () => {
    const fsm: Fsm = {
      initial: 'r',
      states: ['r'],
      transitions: [{ from: 'r', on: 'again', to: 'r' }],
    };
    expect(stepFlat(fsm, 'r', 'again')).toEqual({ next: 'r', transitioned: false, via: 0 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HAR.0 — the tree-aware Harel engine.
// ─────────────────────────────────────────────────────────────────────────────
const HIER: Statechart = {
  initial: 'idle',
  root: {
    idle: { kind: 'leaf' },
    build: {
      kind: 'compound',
      initial: 'backend',
      states: { backend: { kind: 'leaf' }, frontend: { kind: 'leaf' } },
    },
    done: { kind: 'leaf' },
  },
  transitions: [
    { from: 'idle', on: 'start', to: 'build' }, // enter compound → its initial child
    { from: 'build/backend', on: 'next', to: 'build/frontend' }, // intra-compound, LCCA = build
    { from: 'build', on: 'finish', to: 'done' }, // leave compound, LCCA = root
  ],
};

describe('validateStatechart (recursive tree validation)', () => {
  it('accepts a well-formed hierarchical machine', () => {
    expect(validateStatechart(HIER)).toEqual([]);
  });

  it('rejects a compound whose initial child is undeclared', () => {
    const bad: Statechart = {
      initial: 'c',
      root: { c: { kind: 'compound', initial: 'ghost', states: { a: { kind: 'leaf' } } } },
      transitions: [],
    };
    expect(validateStatechart(bad)).toContainEqual(
      expect.stringContaining('compound "c" initial "ghost"'),
    );
  });

  it('rejects a transition to an undeclared path', () => {
    const bad: Statechart = {
      initial: 'a',
      root: { a: { kind: 'leaf' } },
      transitions: [{ from: 'a', on: 'x', to: 'build/ghost' }],
    };
    expect(validateStatechart(bad)).toContainEqual(
      expect.stringContaining('to "build/ghost" is not a declared'),
    );
  });
});

describe('step (tree, over configurations)', () => {
  it('initialConfig enters the initial leaf', () => {
    expect([...initialConfig(HIER)]).toEqual(['idle']);
  });

  it('entering a compound activates its initial child (down to a leaf)', () => {
    const r = step(HIER, new Set(['idle']), 'start');
    expect([...r.next]).toEqual(['build/backend']);
    expect(r.transitioned).toBe(true);
  });

  it('an intra-compound transition resolves up to the LCCA (build) and swaps the child', () => {
    const r = step(HIER, new Set(['build/backend']), 'next');
    expect([...r.next]).toEqual(['build/frontend']);
    expect(r.transitioned).toBe(true);
  });

  it('a transition whose `from` is the compound fires from any descendant (leave to root)', () => {
    const r = step(HIER, new Set(['build/frontend']), 'finish');
    expect([...r.next]).toEqual(['done']);
  });

  it('is TOTAL over configurations: no enabled transition → explicit stay', () => {
    const r = step(HIER, new Set(['idle']), 'nope');
    expect([...r.next]).toEqual(['idle']);
    expect(r).toMatchObject({ transitioned: false, via: null });
  });
});

describe('step (parallel / orthogonal regions — the configuration model)', () => {
  const PAR: Statechart = {
    initial: 'par',
    root: {
      par: {
        kind: 'parallel',
        regions: {
          A: {
            kind: 'compound',
            initial: 'a1',
            states: { a1: { kind: 'leaf' }, a2: { kind: 'leaf' } },
          },
          B: {
            kind: 'compound',
            initial: 'b1',
            states: { b1: { kind: 'leaf' }, b2: { kind: 'leaf' } },
          },
        },
      },
    },
    transitions: [{ from: 'par/A/a1', on: 'x', to: 'par/A/a2' }],
  };

  it('entering a parallel node forks into ALL regions (configuration = union)', () => {
    expect([...initialConfig(PAR)].sort()).toEqual(['par/A/a1', 'par/B/b1']);
  });

  it('a transition in one region leaves the other region untouched (independence)', () => {
    const r = step(PAR, new Set(['par/A/a1', 'par/B/b1']), 'x');
    expect([...r.next].sort()).toEqual(['par/A/a2', 'par/B/b1']);
    expect(r.transitioned).toBe(true);
  });
});
