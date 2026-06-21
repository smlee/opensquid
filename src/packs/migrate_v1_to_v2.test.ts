/**
 * M.2 — migrateV1 (foundation + behavior forms; fail-loud).
 *
 * CONFORMANCE-RECONCILE: the v1 rule-LIST `conformance` form is GONE (v2 has no fsm-less gate list;
 * gates live IN the execution FSM as gate-STATES). A v1 discipline pack migrates as a `behavior` FSM
 * with gate-states (authored per-pack, FAC-CUT.3). migrateV1 now handles `foundation` + `behavior` only.
 */
import { describe, expect, it } from 'vitest';

import { Pack } from '../runtime/types.js';
import { migrateV1 } from './migrate_v1_to_v2.js';

describe('migrateV1 — foundation form', () => {
  it('passes the foundation block through; no fsm', () => {
    const v1 = Pack.parse({
      name: 'focused-typescript-strict',
      version: '1.0.0',
      scope: 'specialty',
      goal: 'strict TS expertise',
      foundation: { domains: ['typescript'], methodologies: ['strict-mode'] },
    });
    const v2 = migrateV1(v1, { form: 'foundation' });
    expect(v2.fsm).toBeUndefined();
    expect(v2.foundation).toEqual({
      tools: [],
      domains: ['typescript'],
      methodologies: ['strict-mode'],
    });
  });
});

describe('migrateV1 — behavior form (fsm from the side-file)', () => {
  it('carries table.fsm; transitions SET-EQUAL the supplied fsm (the round-trip shape)', () => {
    const v1 = Pack.parse({
      name: 'coding-flow',
      version: '1.0.0',
      scope: 'workflow',
      goal: 'gate the coding flow',
    });
    const fsm = {
      initial: 'idle',
      states: {
        idle: {
          kind: 'executor' as const,
          skills: [],
          directive: 'start',
          completion: 'ok',
          emits: 'go',
        },
        done: { kind: 'terminal' as const, outcome: 'shipped' as const },
      },
      transitions: [{ from: 'idle', on: 'go', to: 'done' }],
    };
    const v2 = migrateV1(v1, { form: 'behavior', fsm });
    expect(new Set(v2.fsm?.transitions)).toEqual(new Set(fsm.transitions));
  });
});

describe('migrateV1 — fail-loud (never heuristic)', () => {
  it('throws on a behavior pack with no table.fsm', () => {
    const v1 = Pack.parse({ name: 'b', version: '1.0.0', scope: 'workflow', goal: 'g' });
    expect(() => migrateV1(v1, { form: 'behavior' })).toThrow(/needs table\.fsm/);
  });
});
