/** T1 — compile_v2: lower PackV2 → engine machine (explicit named-event transitions) + state-metadata. */
import { describe, expect, it } from 'vitest';

import { step, validateFsm } from '../runtime/fsm.js';
import { compilePackV2 } from './compile_v2.js';
import { PackV2 } from './schemas/pack_v2.js';

// A representative amazon-clone-shaped pack exercising all 5 state kinds, with EXPLICIT named-event
// transitions (structure) separate from the per-state `emits` (behavior).
const amazonClone = PackV2.parse({
  name: 'amazon-clone',
  version: '1.0.0',
  scope: 'workflow',
  fsm: {
    initial: 'spec_review',
    states: {
      spec_review: {
        kind: 'executor',
        executor: 'codex',
        skills: ['spec-authoring'],
        directive: 'Review.',
        completion: 'spec_ok',
        emits: 'spec_done',
      },
      architecture: {
        kind: 'executor',
        directive: 'Design.',
        completion: 'arch_ok',
        emits: 'arch_done',
      },
      size_check: {
        kind: 'gate',
        guard: 'bundle_size_ok',
        on_pass_emits: 'size_passed',
        on_fail: { action: 'block', message: 'size_too_big' },
      },
      es_gate: { kind: 'terminal', outcome: 'shipped' },
      sealed_holdout: {
        kind: 'decision',
        branches: [
          { guard: 'holdout_passes', emits: 'holdout_pass' },
          { else: true, emits: 'holdout_fail' },
        ],
      },
      done: { kind: 'terminal', outcome: 'shipped' },
      build: { kind: 'sub_flow', flow: 'build_pipeline', emits: 'build_done' },
    },
    transitions: [
      { from: 'spec_review', on: 'spec_done', to: 'architecture' },
      { from: 'architecture', on: 'arch_done', to: 'size_check' },
      { from: 'size_check', on: 'size_passed', to: 'es_gate' },
      { from: 'sealed_holdout', on: 'holdout_pass', to: 'done' },
      { from: 'sealed_holdout', on: 'holdout_fail', to: 'build' },
      { from: 'build', on: 'build_done', to: 'es_gate' },
    ],
  },
  messages: { size_too_big: 'Bundle exceeds budget; code-split, re-run.' },
});

describe('compilePackV2 (T1)', () => {
  const { fsm, meta } = compilePackV2(amazonClone);

  it('reuses the AUTHORED explicit transitions (no synthesis) and validates them', () => {
    expect(validateFsm(fsm)).toEqual([]);
    expect(fsm.initial).toBe('spec_review');
    expect(new Set(fsm.states)).toEqual(
      new Set([
        'spec_review',
        'architecture',
        'size_check',
        'es_gate',
        'sealed_holdout',
        'done',
        'build',
      ]),
    );
    // the transitions are the author's named-event edges, verbatim — NOT synthetic `__*` events
    expect(fsm.transitions).toContainEqual({
      from: 'spec_review',
      on: 'spec_done',
      to: 'architecture',
    });
    expect(fsm.transitions).toContainEqual({
      from: 'size_check',
      on: 'size_passed',
      to: 'es_gate',
    });
    expect(fsm.transitions.some((t) => t.on.startsWith('__'))).toBe(false); // no reserved synthesis
  });

  it('carries per-state bindings + the NAMED emit event in meta', () => {
    expect(meta.spec_review).toMatchObject({
      kind: 'executor',
      executor: 'codex',
      skills: ['spec-authoring'],
      completion: 'spec_ok',
      emits: 'spec_done',
    });
    expect(meta.size_check).toMatchObject({
      kind: 'gate',
      guard: 'bundle_size_ok',
      onFail: { action: 'block', message: 'size_too_big' },
      emits: 'size_passed', // on_pass_emits
    });
    expect(meta.sealed_holdout?.branches).toHaveLength(2);
    expect(meta.build).toMatchObject({
      kind: 'sub_flow',
      flow: 'build_pipeline',
      emits: 'build_done',
    });
    expect(meta.es_gate).toMatchObject({ kind: 'terminal', outcome: 'shipped' });
  });

  it('the compiled machine steps on the author-named events', () => {
    expect(step(fsm, 'spec_review', 'spec_done').next).toBe('architecture');
    expect(step(fsm, 'size_check', 'size_passed').next).toBe('es_gate');
    expect(step(fsm, 'sealed_holdout', 'holdout_fail').next).toBe('build');
  });

  it('THROWS at compile on a dangling transition target (validateFsm enforced, not deferred)', () => {
    const bad = PackV2.parse({
      name: 'bad',
      version: '1.0.0',
      scope: 'workflow',
      fsm: {
        initial: 'a',
        states: { a: { kind: 'executor', directive: 'd', completion: 'c', emits: 'go' } },
        transitions: [{ from: 'a', on: 'go', to: 'NOPE' }],
      },
    });
    expect(() => compilePackV2(bad)).toThrow(/invalid FSM/);
  });

  it('THROWS on a driver-emitted event with no routing transition (no silent dead end)', () => {
    const orphan = PackV2.parse({
      name: 'orphan',
      version: '1.0.0',
      scope: 'workflow',
      fsm: {
        initial: 'a',
        states: {
          a: { kind: 'executor', directive: 'd', completion: 'c', emits: 'ghost' },
          done: { kind: 'terminal', outcome: 'shipped' },
        },
        transitions: [], // `ghost` is emitted but never routed
      },
    });
    expect(() => compilePackV2(orphan)).toThrow(/emitted but unrouted events — ghost/);
  });

  it('THROWS on a decision whose branches emit a duplicate event (an unreachable branch)', () => {
    const dupe = PackV2.parse({
      name: 'dupe',
      version: '1.0.0',
      scope: 'workflow',
      fsm: {
        initial: 'd',
        states: {
          d: {
            kind: 'decision',
            branches: [
              { guard: 'hot', emits: 'same' },
              { else: true, emits: 'same' },
            ],
          },
          done: { kind: 'terminal', outcome: 'shipped' },
        },
        transitions: [{ from: 'd', on: 'same', to: 'done' }],
      },
    });
    expect(() => compilePackV2(dupe)).toThrow(/duplicate branch emit 'same'/);
  });
});

// THE KEYSTONE: a fixture proving the model reproduces coding-flow's transition shape WITHIN this track —
// multi-out per state on different events + a `from:'*'` wildcard + all 5 kinds, with NO synthetic events.
describe('compilePackV2 (T1) — coding-flow-shaped fixture: multi-out + wildcard + all 5 kinds', () => {
  const fixture = PackV2.parse({
    name: 'codingflow-fixture',
    version: '0.0.1',
    scope: 'workflow',
    fsm: {
      initial: 'idle',
      states: {
        // `idle` is a gate with MULTI-OUT: two transitions on DIFFERENT observed events.
        idle: {
          kind: 'gate',
          guard: 'always',
          trigger: ['scope_start', 'research_done'], // OBSERVED events (conformance)
          on_pass_emits: 'scope_start',
          on_fail: { action: 'block', message: 'idle blocked' },
        },
        scoping: {
          kind: 'executor',
          directive: 'scope',
          completion: 'scoped',
          emits: 'research_done',
        },
        researched: { kind: 'decision', branches: [{ else: true, emits: 'spec_drafted' }] },
        authoring: { kind: 'sub_flow', flow: 'author_impl', emits: 'phase_started' },
        done: { kind: 'terminal', outcome: 'shipped' },
      },
      transitions: [
        // MULTI-OUT from `idle` on two different events:
        { from: 'idle', on: 'scope_start', to: 'scoping' },
        { from: 'idle', on: 'research_done', to: 'researched' },
        { from: 'scoping', on: 'research_done', to: 'researched' },
        { from: 'researched', on: 'spec_drafted', to: 'authoring' },
        { from: 'authoring', on: 'phase_started', to: 'done' },
        // WILDCARD: a task-reset from ANY state (the coding-flow `from:'*'` shape).
        { from: '*', on: 'task_unscoped', to: 'scoping' },
      ],
    },
  });

  const { fsm } = compilePackV2(fixture);

  it('compiles with NO synthetic events', () => {
    expect(validateFsm(fsm)).toEqual([]);
    expect(fsm.transitions.some((t) => t.on.startsWith('__'))).toBe(false);
  });

  it('reproduces MULTI-OUT: `idle` routes two different events to two different targets', () => {
    expect(step(fsm, 'idle', 'scope_start').next).toBe('scoping');
    expect(step(fsm, 'idle', 'research_done').next).toBe('researched');
  });

  it('reproduces the WILDCARD: `task_unscoped` resets to scoping from ANY state', () => {
    expect(step(fsm, 'done', 'task_unscoped').next).toBe('scoping');
    expect(step(fsm, 'authoring', 'task_unscoped').next).toBe('scoping');
    expect(step(fsm, 'researched', 'task_unscoped').next).toBe('scoping');
  });

  it('a non-matching event is an explicit STAY (totality), never a stall', () => {
    const r = step(fsm, 'scoping', 'nonsense');
    expect(r.transitioned).toBe(false);
    expect(r.next).toBe('scoping');
  });
});
