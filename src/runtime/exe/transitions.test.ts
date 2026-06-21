/** EXE.1 — per-current-state transition evaluation + orthogonal-region arbitration. */
import { describe, expect, it } from 'vitest';

import { compilePackV2, type CompiledPack } from '../../packs/compile_v2.js';
import { PackV2 } from '../../packs/schemas/pack_v2.js';
import type { GuardEvaluator } from '../loop/driver.js';
import { arbitrate, evaluateTransition, type Region } from './transitions.js';

function compile(name: string): CompiledPack {
  return compilePackV2(
    PackV2.parse({
      name,
      version: '0.0.1',
      scope: 'project',
      guards: { ok: 'true', hot: 'true' }, // FAC-CUT.2: gate/decision guard refs
      fsm: {
        initial: 'g',
        states: {
          g: {
            kind: 'gate',
            guard: 'ok',
            on_pass_emits: 'g_pass',
            on_fail: { action: 'block', message: `${name}: blocked` },
          },
          d: {
            kind: 'decision',
            branches: [
              { guard: 'hot', emits: 'd_hot' },
              { else: true, emits: 'd_else' },
            ],
          },
          work: {
            kind: 'executor',
            executor: 'codex',
            directive: 'do it',
            completion: 'c',
            emits: 'work_done',
          },
          done: { kind: 'terminal', outcome: 'shipped' },
        },
        transitions: [
          { from: 'g', on: 'g_pass', to: 'd' },
          { from: 'd', on: 'd_hot', to: 'work' },
          { from: 'd', on: 'd_else', to: 'done' },
          { from: 'work', on: 'work_done', to: 'done' },
        ],
      },
    }),
  );
}

const PACK = compile('p');
const guardsReturning = (val: boolean): GuardEvaluator => ({ eval: () => val });

describe('evaluateTransition (EXE.1) — only the current state, no global walk', () => {
  it('gate pass → advances to on_pass.to', async () => {
    expect(await evaluateTransition(PACK, 'g', 'x', undefined, guardsReturning(true))).toEqual({
      next: 'd',
    });
  });

  it('gate fail → the on_fail action (no transition)', async () => {
    expect(await evaluateTransition(PACK, 'g', 'x', undefined, guardsReturning(false))).toEqual({
      action: { action: 'block', message: 'p: blocked' },
    });
  });

  it('decision first-match guarded branch wins', async () => {
    expect(await evaluateTransition(PACK, 'd', 'x', undefined, guardsReturning(true))).toEqual({
      next: 'work',
    });
  });

  it('decision falls through to the total else', async () => {
    expect(await evaluateTransition(PACK, 'd', 'x', undefined, guardsReturning(false))).toEqual({
      next: 'done',
    });
  });

  it('executor transitions on the NAMED completion event the driver emits (behavior is the driver’s job)', async () => {
    expect(
      await evaluateTransition(PACK, 'work', 'work_done', undefined, guardsReturning(true)),
    ).toEqual({ next: 'done' });
  });

  it('terminal has no outgoing transition', async () => {
    expect(await evaluateTransition(PACK, 'done', 'x', undefined, guardsReturning(true))).toEqual(
      {},
    );
  });

  it('an unknown state is a loud bug (the driver adds no behavior of its own)', async () => {
    await expect(
      evaluateTransition(PACK, 'ghost', 'x', undefined, guardsReturning(true)),
    ).rejects.toThrow(/no meta for state/);
  });
});

describe('arbitrate (EXE.1) — orthogonal-region composition (scope-precedence, first-blocking-wins)', () => {
  it('first-blocking region short-circuits; earlier non-blocking advances are kept', async () => {
    // region order = precedence. r1 passes (advance), r2 blocks → short-circuit before r3.
    const regions: Region[] = [
      { compiled: compile('r1'), state: 'g' },
      { compiled: compile('r2'), state: 'g' },
      { compiled: compile('r3'), state: 'g' },
    ];
    // a guard evaluator that passes r1's gate but fails r2's: key off the pack message via ctx.
    let call = 0;
    const guards: GuardEvaluator = { eval: () => ++call === 1 }; // 1st (r1) true, rest false
    const out = await arbitrate(regions, 'x', undefined, guards);
    expect(out.blocked).toEqual({ action: 'block', message: 'r2: blocked' });
    expect(out.advances).toEqual([{ region: regions[0], next: 'd' }]); // r1 advanced; r3 never evaluated
  });

  it('no region blocks → all advances accumulate in precedence order', async () => {
    const regions: Region[] = [
      { compiled: compile('r1'), state: 'g' },
      { compiled: compile('r2'), state: 'g' },
    ];
    const out = await arbitrate(regions, 'x', undefined, guardsReturning(true));
    expect(out.blocked).toBeUndefined();
    expect(out.advances).toEqual([
      { region: regions[0], next: 'd' },
      { region: regions[1], next: 'd' },
    ]);
  });
});

// WARN-GATE-COMPLETION — warn = a NON-blocking advance + notice; arbitrate must NOT short-circuit on it.
function compileWarn(name: string): CompiledPack {
  return compilePackV2(
    PackV2.parse({
      name,
      version: '0.0.1',
      scope: 'project',
      guards: { ok: 'true' },
      fsm: {
        initial: 'g',
        states: {
          g: {
            kind: 'gate',
            guard: 'ok',
            on_pass_emits: 'g_pass',
            on_fail: { action: 'warn', message: `${name}: nudge` },
          },
          done: { kind: 'terminal', outcome: 'shipped' },
        },
        transitions: [{ from: 'g', on: 'g_pass', to: 'done' }],
      },
    }),
  );
}

describe('WARN-GATE-COMPLETION — warn advances + surfaces a notice (non-blocking)', () => {
  it('evaluateTransition: gate guard fails + on_fail=warn → {next, notice} (no action)', async () => {
    const out = await evaluateTransition(
      compileWarn('w'),
      'g',
      'x',
      undefined,
      guardsReturning(false),
    );
    expect(out).toEqual({ next: 'done', notice: 'w: nudge' });
    expect(out.action).toBeUndefined();
  });

  it('arbitrate: a warn region does NOT short-circuit — a later region still advances', async () => {
    const regions: Region[] = [
      { compiled: compileWarn('w1'), state: 'g' },
      { compiled: compileWarn('w2'), state: 'g' },
    ];
    const out = await arbitrate(regions, 'x', undefined, guardsReturning(false)); // both warn (guards fail)
    expect(out.blocked).toBeUndefined();
    expect(out.advances).toEqual([
      { region: regions[0], next: 'done', notice: 'w1: nudge' },
      { region: regions[1], next: 'done', notice: 'w2: nudge' },
    ]);
  });
});
