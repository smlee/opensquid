/** LOOP.1 — the generic loop driver (per-state dispatch over a compiled pack FSM). */
import { describe, expect, it } from 'vitest';

import { compilePackV2 } from '../../packs/compile_v2.js';
import { PackV2 } from '../../packs/schemas/pack_v2.js';
import {
  LoopDriver,
  type Executor,
  type ExecutorRegistry,
  type GuardEvaluator,
  type InnerStep,
} from './driver.js';
import type { ToolObservation } from '../guard/progress_floor.js';

// A small amazon-clone-style pack exercising all 5 state kinds.
const PACK = PackV2.parse({
  name: 'demo',
  version: '0.0.1',
  scope: 'project',
  fsm: {
    initial: 'review',
    states: {
      review: {
        kind: 'executor',
        executor: 'codex',
        skills: ['spec'],
        directive: 'review the spec',
        completion: 'spec_ok',
        next: 'gate_size',
      },
      gate_size: {
        kind: 'gate',
        guard: 'size_ok',
        on_pass: { to: 'decide' },
        on_fail: { action: 'block', message: 'spec too big — split it' },
      },
      decide: {
        kind: 'decision',
        branches: [
          { guard: 'holdout_ok', to: 'done' },
          { else: true, to: 'build' },
        ],
      },
      build: { kind: 'sub_flow', flow: 'build_impl', on_complete: { to: 'done' } },
      build_impl: {
        kind: 'executor',
        executor: 'codex',
        directive: 'build it',
        completion: 'built',
        next: 'build_done',
      },
      build_done: { kind: 'terminal', outcome: 'shipped' },
      done: { kind: 'terminal', outcome: 'shipped' },
    },
  },
});
const COMPILED = compilePackV2(PACK);

const ok = (tool: string, argsHash: string): ToolObservation => ({
  tool,
  argsHash,
  failed: false,
  idempotentSameResult: false,
});
const fail = (tool: string, argsHash: string): ToolObservation => ({
  tool,
  argsHash,
  failed: true,
  idempotentSameResult: false,
});

function makeExecutor(steps: InnerStep[]): Executor {
  const q = [...steps];
  return { next: () => Promise.resolve(q.shift() ?? null) };
}
function registryOf(exec: Executor): ExecutorRegistry {
  return { ensureExecutor: () => Promise.resolve(exec) };
}
const failClosedRegistry: ExecutorRegistry = {
  ensureExecutor: (name) => Promise.reject(new Error(`cannot connect executor '${name}'`)),
};
const guardsReturning = (val: boolean): GuardEvaluator => ({ eval: () => val });

describe('LoopDriver (LOOP.1)', () => {
  it('executor: completion guard holds → advances on __complete to `next`', async () => {
    const exec = makeExecutor([{ observation: ok('edit', 'a'), completionGuardHeld: true }]);
    const d = new LoopDriver(COMPILED, {
      registry: registryOf(exec),
      guards: guardsReturning(true),
    });
    expect(await d.step('review')).toEqual({ kind: 'advance', next: 'gate_size' });
  });

  it('executor: Progress-floor halt (degenerate loop) → wedge (safety break)', async () => {
    // 8 failures of the same tool (distinct args) → same_tool=8 → floor halt → connector break
    const steps: InnerStep[] = Array.from({ length: 8 }, (_, i) => ({
      observation: fail('edit', `arg${i}`),
      completionGuardHeld: false,
    }));
    const d = new LoopDriver(COMPILED, {
      registry: registryOf(makeExecutor(steps)),
      guards: guardsReturning(true),
    });
    const r = await d.step('review');
    expect(r).toMatchObject({ kind: 'outcome', outcome: 'wedge' });
  });

  it('executor anti-self-grading: claims done but guard fails → does NOT advance (loops, then exhausts→wedge)', async () => {
    // completionGuardHeld:false means the guard did NOT hold despite the agent claiming done.
    const exec = makeExecutor([{ observation: ok('edit', 'a'), completionGuardHeld: false }]); // then null
    const d = new LoopDriver(COMPILED, {
      registry: registryOf(exec),
      guards: guardsReturning(true),
    });
    const r = await d.step('review');
    expect(r).toMatchObject({ kind: 'outcome', outcome: 'wedge' }); // never advanced on the false claim
    if (r.kind === 'outcome') expect(r.reason).toMatch(/exhausted/);
  });

  it('executor resolution is FAIL-CLOSED: an unconnectable executor throws (no wrong-fallback)', async () => {
    const d = new LoopDriver(COMPILED, {
      registry: failClosedRegistry,
      guards: guardsReturning(true),
    });
    await expect(d.step('review')).rejects.toThrow(/cannot connect executor 'codex'/);
  });

  it('gate: guard passes → advances on __pass to on_pass.to', async () => {
    const d = new LoopDriver(COMPILED, {
      registry: failClosedRegistry,
      guards: guardsReturning(true),
    });
    expect(await d.step('gate_size')).toEqual({ kind: 'advance', next: 'decide' });
  });

  it('gate: guard fails → on_fail ACTION (block + self-continue message), no transition', async () => {
    const d = new LoopDriver(COMPILED, {
      registry: failClosedRegistry,
      guards: guardsReturning(false),
    });
    expect(await d.step('gate_size')).toEqual({
      kind: 'action',
      action: 'block',
      message: 'spec too big — split it',
    });
  });

  it('decision: first-match guarded branch wins', async () => {
    const d = new LoopDriver(COMPILED, {
      registry: failClosedRegistry,
      guards: guardsReturning(true), // holdout_ok holds → first branch
    });
    expect(await d.step('decide')).toEqual({ kind: 'advance', next: 'done' });
  });

  it('decision: no guard matches → total `else` fallback', async () => {
    const d = new LoopDriver(COMPILED, {
      registry: failClosedRegistry,
      guards: guardsReturning(false), // holdout_ok fails → else → build
    });
    expect(await d.step('decide')).toEqual({ kind: 'advance', next: 'build' });
  });

  it('sub_flow: recurses to its terminal (shipped), then parent advances on __subflow_done', async () => {
    // build → runs build_impl (executor, guard holds) → build_done (terminal shipped) → parent → done
    const exec = makeExecutor([{ observation: ok('write', 'b'), completionGuardHeld: true }]);
    const d = new LoopDriver(COMPILED, {
      registry: registryOf(exec),
      guards: guardsReturning(true),
    });
    expect(await d.step('build')).toEqual({ kind: 'advance', next: 'done' });
  });

  it('terminal: returns the outcome', async () => {
    const d = new LoopDriver(COMPILED, {
      registry: failClosedRegistry,
      guards: guardsReturning(true),
    });
    expect(await d.step('done')).toEqual({ kind: 'outcome', outcome: 'shipped' });
  });

  it('the driver has no behavior of its own: an unknown state is a loud bug', async () => {
    const d = new LoopDriver(COMPILED, {
      registry: failClosedRegistry,
      guards: guardsReturning(true),
    });
    await expect(d.step('nope')).rejects.toThrow(/no meta for state/);
  });
});
