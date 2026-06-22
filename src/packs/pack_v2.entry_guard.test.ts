/** ORCH.8 — the entry-guard contract: a serves-bearing pack with an fsm must start at a gate (propose/dispose). */
import { describe, expect, it } from 'vitest';

import { PackV2 } from './schemas/pack_v2.js';

const base = { name: 'p', version: '1.0.0', scope: 'workflow' as const };

const gateFsm = {
  initial: 'g0',
  states: {
    g0: {
      kind: 'gate',
      guard: 'ok',
      on_pass_emits: 'done',
      on_fail: { action: 'block', message: 'resolve it' },
    },
    end: { kind: 'terminal', outcome: 'shipped' },
  },
  transitions: [{ from: 'g0', on: 'done', to: 'end' }],
};
const executorFsm = {
  initial: 'e0',
  states: {
    e0: { kind: 'executor', directive: 'do the thing', completion: 'ok', emits: 'done' },
    end: { kind: 'terminal', outcome: 'shipped' },
  },
  transitions: [{ from: 'e0', on: 'done', to: 'end' }],
};

describe('ORCH.8 — pack entry-guard contract', () => {
  it('serves + fsm starting at a gate → valid', () => {
    expect(() =>
      PackV2.parse({
        ...base,
        serves: { intent: 'produce' },
        fsm: gateFsm,
        guards: { ok: 'true' },
      }),
    ).not.toThrow();
  });

  it('serves + fsm starting at a NON-gate (executor) → parse error (entry-guard required)', () => {
    expect(() =>
      PackV2.parse({
        ...base,
        serves: { intent: 'produce' },
        fsm: executorFsm,
        guards: { ok: 'true' },
      }),
    ).toThrow(/gate.*state|entry.fit.guard|ORCH\.8/i);
  });

  it('serves + NO fsm → valid (refine fires only when both present)', () => {
    expect(() => PackV2.parse({ ...base, serves: { intent: 'inform' } })).not.toThrow();
  });

  it('fsm (non-gate start) + NO serves → valid (a non-routed pack needs no entry-guard)', () => {
    expect(() => PackV2.parse({ ...base, fsm: executorFsm, guards: { ok: 'true' } })).not.toThrow();
  });
});
