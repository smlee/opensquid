/** PFV2.1 — compile_v2: lower PackV2 → engine machine + state-metadata. */
import { describe, expect, it } from 'vitest';

import { validateFsm } from '../runtime/fsm.js';
import { compilePackV2 } from './compile_v2.js';
import { PackV2 } from './schemas/pack_v2.js';

// A representative amazon-clone-shaped pack exercising all 5 state kinds.
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
        next: 'architecture',
      },
      architecture: {
        kind: 'executor',
        directive: 'Design.',
        completion: 'arch_ok',
        next: 'size_check',
      },
      size_check: {
        kind: 'gate',
        guard: 'bundle_size_ok',
        on_pass: { to: 'es_gate' },
        on_fail: { action: 'block', message: 'size_too_big' },
      },
      es_gate: { kind: 'terminal', outcome: 'shipped' },
      sealed_holdout: {
        kind: 'decision',
        branches: [
          { guard: 'holdout_passes', to: 'done' },
          { else: true, to: 'build' },
        ],
      },
      done: { kind: 'terminal', outcome: 'shipped' },
      build: { kind: 'sub_flow', flow: 'build_pipeline', on_complete: { to: 'es_gate' } },
    },
  },
  messages: { size_too_big: 'Bundle exceeds budget; code-split, re-run.' },
});

describe('compilePackV2 (PFV2.1)', () => {
  const { fsm, meta } = compilePackV2(amazonClone);

  it('lowers to a machine the reused engine validates (all targets declared, total)', () => {
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
  });

  it('emits one transition per executor/gate/sub_flow state and one per decision branch; none for terminals', () => {
    const t = fsm.transitions;
    expect(t).toContainEqual({
      from: 'spec_review',
      on: '__complete:spec_review',
      to: 'architecture',
    });
    expect(t).toContainEqual({ from: 'size_check', on: '__pass:size_check', to: 'es_gate' });
    expect(t).toContainEqual({ from: 'build', on: '__subflow_done:build', to: 'es_gate' });
    expect(t).toContainEqual({
      from: 'sealed_holdout',
      on: '__branch:sealed_holdout:0',
      to: 'done',
    });
    expect(t).toContainEqual({
      from: 'sealed_holdout',
      on: '__branch:sealed_holdout:1',
      to: 'build',
    });
    // terminals emit nothing:
    expect(t.some((x) => x.from === 'es_gate' || x.from === 'done')).toBe(false);
  });

  it('carries per-state bindings in meta', () => {
    expect(meta.spec_review).toMatchObject({
      kind: 'executor',
      executor: 'codex',
      skills: ['spec-authoring'],
      completion: 'spec_ok',
    });
    expect(meta.size_check).toMatchObject({
      kind: 'gate',
      guard: 'bundle_size_ok',
      onFail: { action: 'block', message: 'size_too_big' },
    });
    expect(meta.sealed_holdout?.branches).toHaveLength(2);
    expect(meta.build).toMatchObject({ kind: 'sub_flow', flow: 'build_pipeline' });
    expect(meta.es_gate).toMatchObject({ kind: 'terminal', outcome: 'shipped' });
  });

  it('reserves `__`-prefixed events (no author event collides)', () => {
    expect(fsm.transitions.every((t) => t.on.startsWith('__'))).toBe(true);
  });

  it('THROWS at compile on a dangling transition target (validateFsm enforced, not deferred)', () => {
    const bad = PackV2.parse({
      name: 'bad',
      version: '1.0.0',
      scope: 'workflow',
      fsm: {
        initial: 'a',
        states: { a: { kind: 'executor', directive: 'd', completion: 'c', next: 'NOPE' } },
      },
    });
    expect(() => compilePackV2(bad)).toThrow(/invalid FSM/);
  });
});
