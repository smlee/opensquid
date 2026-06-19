/** PFV2.1 — pack-format-v2 schema validation. */
import { describe, expect, it } from 'vitest';

import { PackV2, StateV2 } from './pack_v2.js';

const baseFsm = {
  initial: 'a',
  states: {
    a: { kind: 'executor', directive: 'do', completion: 'a_ok', emits: 'a_done' },
    b: { kind: 'terminal', outcome: 'shipped' },
  },
  transitions: [{ from: 'a', on: 'a_done', to: 'b' }],
};

describe('PackV2 schema (PFV2.1)', () => {
  it('parses a minimal valid pack and defaults detected_by/guards/messages', () => {
    const p = PackV2.parse({ name: 'p', version: '1.0.0', scope: 'workflow', fsm: baseFsm });
    expect(p.detected_by).toEqual([]);
    expect(p.guards).toEqual({});
    expect(p.messages).toEqual({});
    expect(p.fsm?.states.a?.kind).toBe('executor');
  });

  it('rejects an executor state missing `completion`', () => {
    expect(() => StateV2.parse({ kind: 'executor', directive: 'do', emits: 'b' })).toThrow();
  });

  it('rejects a gate `on_fail.action` that is not block|halt (warn/pass are not on_fail)', () => {
    expect(() =>
      StateV2.parse({
        kind: 'gate',
        guard: 'g',
        on_pass_emits: 'passed',
        on_fail: { action: 'warn', message: 'm' },
      }),
    ).toThrow();
  });

  it('rejects a decision with zero branches', () => {
    expect(() => StateV2.parse({ kind: 'decision', branches: [] })).toThrow();
  });

  it('accepts a decision with a guard branch and an else branch', () => {
    const s = StateV2.parse({
      kind: 'decision',
      branches: [
        { guard: 'g', emits: 'hot' },
        { else: true, emits: 'cold' },
      ],
    });
    expect(s.kind).toBe('decision');
  });

  it('accepts a gate with an optional observed `trigger` (the conformance case)', () => {
    const s = StateV2.parse({
      kind: 'gate',
      guard: 'g',
      trigger: ['tool_call', 'stop'],
      on_pass_emits: 'passed',
      on_fail: { action: 'block', message: 'm' },
    });
    expect(s.kind).toBe('gate');
  });

  it('rejects an unknown kind', () => {
    expect(() => StateV2.parse({ kind: 'nope' })).toThrow();
  });

  it('rejects a cross-kind field (.strict) — a guard on an executor state fails loud, not silently dropped', () => {
    expect(() =>
      StateV2.parse({
        kind: 'executor',
        directive: 'd',
        completion: 'c',
        emits: 'n',
        guard: 'OOPS',
      }),
    ).toThrow();
  });

  it('rejects a decision with no `else` (totality)', () => {
    expect(() =>
      StateV2.parse({ kind: 'decision', branches: [{ guard: 'g', emits: 'a' }] }),
    ).toThrow();
  });

  it('rejects a decision whose `else` is not last (totality)', () => {
    expect(() =>
      StateV2.parse({
        kind: 'decision',
        branches: [
          { else: true, emits: 'a' },
          { guard: 'g', emits: 'b' },
        ],
      }),
    ).toThrow();
  });
});

// M.1 — the 3-form pack: a behavior FSM XOR a conformance gate-set XOR foundation-only.
describe('PackV2 schema (M.1) — fsm | gates | foundation', () => {
  const gatesPack = {
    name: 'discipline',
    version: '1.0.0',
    scope: 'universal',
    gates: [
      { kind: 'track_check', trigger: ['tool_call'], process: [{ call: 'c' }] },
      { kind: 'destination_check', prompt_template: 'ok?', every_n_tool_calls: 5 },
    ],
  };

  it('parses a CONFORMANCE pack (gates, no fsm) — the two rule kinds', () => {
    const p = PackV2.parse(gatesPack);
    expect(p.fsm).toBeUndefined();
    expect(p.gates).toHaveLength(2);
    expect(p.gates?.[0]?.kind).toBe('track_check');
    expect(p.gates?.[1]?.kind).toBe('destination_check');
  });

  it('parses a FOUNDATION pack (no fsm, no gates) — pure expertise', () => {
    const p = PackV2.parse({
      name: 'focused-typescript-strict',
      version: '1.0.0',
      scope: 'specialty',
      foundation: { manifest: 'strict-ts' },
    });
    expect(p.fsm).toBeUndefined();
    expect(p.gates).toBeUndefined();
  });

  it('REJECTS a pack carrying BOTH fsm and gates (never two behaviors)', () => {
    expect(() => PackV2.parse({ ...gatesPack, fsm: baseFsm })).toThrow(
      /`fsm` \(behavior\) OR `gates` \(conformance\), not both/,
    );
  });

  it('rejects a destination_check with every_n_tool_calls = 0 (positive int)', () => {
    expect(() =>
      PackV2.parse({
        name: 'bad',
        version: '1.0.0',
        scope: 'universal',
        gates: [{ kind: 'destination_check', prompt_template: 'p', every_n_tool_calls: 0 }],
      }),
    ).toThrow();
  });

  it('rejects a track_check gate with an empty process (min 1)', () => {
    expect(() =>
      PackV2.parse({
        name: 'bad',
        version: '1.0.0',
        scope: 'universal',
        gates: [{ kind: 'track_check', trigger: ['tool_call'], process: [] }],
      }),
    ).toThrow();
  });

  it('rejects an unknown conformance gate kind (discriminated union is total)', () => {
    expect(() =>
      PackV2.parse({
        name: 'bad',
        version: '1.0.0',
        scope: 'universal',
        gates: [{ kind: 'nope', trigger: ['x'], process: [{ call: 'c' }] }],
      }),
    ).toThrow();
  });
});
