import { describe, expect, it } from 'vitest';

import { compilePackV2 } from '../../packs/compile_v2.js';
import { PackV2 } from '../../packs/schemas/pack_v2.js';
import { RegistryGuardEvaluator } from './guard_evaluator.js';

describe('FAC-CUT.2 — RegistryGuardEvaluator (pure boolean guard over evalCondition)', () => {
  const ev = new RegistryGuardEvaluator(
    new Map([
      ['ok', 'x > 1'],
      ['no', 'x < 0'],
      ['blank', ''],
      ['broken', 'x >'], // malformed → evalCondition fails closed to false
    ]),
  );

  it('returns the expression truth over the ctx bindings', () => {
    const ctx = new Map<string, unknown>([['x', 2]]);
    expect(ev.eval('ok', ctx)).toBe(true);
    expect(ev.eval('no', ctx)).toBe(false);
  });

  it('an empty expression is a trivially-true predicate (evalCondition lock)', () => {
    expect(ev.eval('blank', new Map())).toBe(true);
  });

  it('a malformed expression fails CLOSED to false (guard fails → gate blocks via on_fail)', () => {
    expect(ev.eval('broken', new Map([['x', 2]]))).toBe(false);
  });

  it('a ref absent from the registry throws (fail-loud, never a silent pass)', () => {
    expect(() => ev.eval('missing', new Map())).toThrow(/no guard expression for ref 'missing'/);
  });

  it('powers decision branch selection (first holding branch — the driver loops eval)', () => {
    const ctx = new Map<string, unknown>([['x', 5]]);
    // mirrors driver.runDecision: first branch whose guard holds wins
    const branches = [
      { guard: 'no', emits: 'a' },
      { guard: 'ok', emits: 'b' },
    ];
    const pick = branches.find((b) => ev.eval(b.guard, ctx));
    expect(pick?.emits).toBe('b');
  });
});

describe('FAC-CUT.2 — compile_v2 guardExprs + dangling-ref fail-loud', () => {
  const behaviorPack = (guards: Record<string, string>) =>
    PackV2.parse({
      name: 'gp',
      version: '1.0.0',
      scope: 'project',
      guards,
      fsm: {
        initial: 'g',
        states: {
          g: {
            kind: 'gate',
            guard: 'ok',
            on_pass_emits: 'passed',
            on_fail: { action: 'block', message: 'no' },
          },
          done: { kind: 'terminal', outcome: 'shipped' },
        },
        transitions: [{ from: 'g', on: 'passed', to: 'done' }],
      },
    });

  it('exposes guardExprs (guard ref → expression) on the compiled behavior pack', () => {
    const compiled = compilePackV2(behaviorPack({ ok: 'x > 1' }));
    expect(compiled.guardExprs?.get('ok')).toBe('x > 1');
  });

  it('a guard ref with no registry entry fails LOUD at compile', () => {
    expect(() => compilePackV2(behaviorPack({}))).toThrow(
      /guard ref 'ok' not in the guards registry/,
    );
  });

  it('compiled guardExprs drives a RegistryGuardEvaluator end-to-end', () => {
    const compiled = compilePackV2(behaviorPack({ ok: 'x > 1' }));
    const e = new RegistryGuardEvaluator(compiled.guardExprs ?? new Map());
    expect(e.eval('ok', new Map([['x', 9]]))).toBe(true);
    expect(e.eval('ok', new Map([['x', 0]]))).toBe(false);
  });
});
