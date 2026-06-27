/** FAC-CUT.5b.1 — V2ObservedActor: the event-driven observed runtime over a real compiled v2 cartridge. */
import { describe, expect, it } from 'vitest';

import { compilePackV2 } from '../../packs/compile_v2.js';
import { PackV2 } from '../../packs/schemas/pack_v2.js';
import type { LoadedPackV2 } from '../../packs/loader_v2.js';
import type { Envelope, MessageKind } from '../bus/types.js';
import { V2ObservedActor } from './v2_observed_actor.js';

/** Build a LoadedPackV2 from an inline PackV2 (mirrors compile_v2.test.ts). */
function load(spec: unknown): LoadedPackV2 {
  const pack = PackV2.parse(spec);
  return {
    pack,
    compiled: compilePackV2(pack),
    guards: pack.guards,
    messages: pack.messages,
    skills: [],
  };
}

/** A gate that passes iff ctx `verdict === "PASS"` (mirrors the real `contains(guess_audit,"GUESS_FREE")`). */
const gatePack = (onFailAction: 'block' | 'warn') =>
  load({
    name: 'observed-gate',
    version: '1.0.0',
    scope: 'workflow',
    guards: { ok: 'verdict == "PASS"' },
    fsm: {
      initial: 'g0',
      states: {
        g0: {
          kind: 'gate',
          guard: 'ok',
          trigger: ['tool_call'],
          on_pass_emits: 'done',
          on_fail: { action: onFailAction, message: 'resolve it' },
        },
        shipped: { kind: 'terminal', outcome: 'shipped' },
      },
      transitions: [{ from: 'g0', on: 'done', to: 'shipped' }],
    },
  });

function env(kind: MessageKind, ctx: unknown): Envelope {
  return { seq: 1, from: 'agent', to: 'pack:observed-gate', kind, payload: { ctx }, ts: 0 };
}
const pass = new Map<string, unknown>([['verdict', 'PASS']]);
const fail = new Map<string, unknown>([['verdict', 'FAIL']]);

describe('V2ObservedActor — event-driven observed stepping', () => {
  it('gate pass → advance: write_state + transition, no gate_action; state advances', async () => {
    const a = new V2ObservedActor('pack:observed-gate', gatePack('block'));
    const effects = await a.receive(env('tool_call', pass));
    expect(effects).toEqual([
      { kind: 'write_state', state: 'shipped' },
      {
        kind: 'emit',
        to: 'topic:transition',
        messageKind: 'transition',
        payload: { from: 'g0', to: 'shipped' },
      },
    ]);
    expect(a.state.current).toBe('shipped');
  });

  it('gate fail + block → gate_action, NO advance (enforce, stay)', async () => {
    const a = new V2ObservedActor('pack:observed-gate', gatePack('block'));
    const effects = await a.receive(env('tool_call', fail));
    expect(effects).toEqual([
      {
        kind: 'emit',
        to: 'topic:gate_action',
        messageKind: 'gate_action',
        payload: { action: 'block', failureType: 'g0', message: 'resolve it' },
      },
    ]);
    expect(a.state.current).toBe('g0'); // unchanged — enforce
  });

  it('gate fail + warn → advance + a warn gate_action (proceed + nudge)', async () => {
    const a = new V2ObservedActor('pack:observed-gate', gatePack('warn'));
    const effects = await a.receive(env('tool_call', fail));
    expect(effects).toContainEqual({ kind: 'write_state', state: 'shipped' });
    expect(effects).toContainEqual({
      kind: 'emit',
      to: 'topic:gate_action',
      messageKind: 'gate_action',
      payload: { action: 'warn', failureType: 'g0', message: 'resolve it' },
    });
    expect(a.state.current).toBe('shipped');
  });

  it('an observation NOT in the current gate trigger → [] (await-point honored)', async () => {
    const a = new V2ObservedActor('pack:observed-gate', gatePack('block'));
    expect(await a.receive(env('prompt_submit', pass))).toEqual([]);
    expect(a.state.current).toBe('g0');
  });

  it('chains a decision auto-evaluated after a gate, within one receive', async () => {
    const a = new V2ObservedActor(
      'pack:chain',
      load({
        name: 'chain',
        version: '1.0.0',
        scope: 'workflow',
        guards: { ok: 'verdict == "PASS"', route_a: 'verdict == "PASS"' },
        fsm: {
          initial: 'g0',
          states: {
            g0: {
              kind: 'gate',
              guard: 'ok',
              trigger: ['tool_call'],
              on_pass_emits: 'g0_done',
              on_fail: { action: 'block', message: 'x' },
            },
            d0: {
              kind: 'decision',
              branches: [
                { guard: 'route_a', emits: 'to_a' },
                { else: true, emits: 'to_b' },
              ],
            },
            a: { kind: 'terminal', outcome: 'shipped' },
            b: { kind: 'terminal', outcome: 'shipped' },
          },
          transitions: [
            { from: 'g0', on: 'g0_done', to: 'd0' },
            { from: 'd0', on: 'to_a', to: 'a' },
            { from: 'd0', on: 'to_b', to: 'b' },
          ],
        },
      }),
    );
    const effects = await a.receive(env('tool_call', pass));
    // g0 advances to d0, d0 auto-routes to 'a' — both transitions in ONE receive.
    const targets = effects
      .filter((e): e is Extract<typeof e, { kind: 'emit' }> => e.kind === 'emit')
      .map((e) => (e.payload as { to: string }).to);
    expect(targets).toEqual(['d0', 'a']);
    expect(a.state.current).toBe('a');
  });

  it('subscribe() returns the union of gate trigger kinds', () => {
    const a = new V2ObservedActor('pack:observed-gate', gatePack('block'));
    expect(a.subscribe()).toEqual(['tool_call']);
  });

  it('is PURE — constructed with no bus/registry; receive only returns effects', async () => {
    const a = new V2ObservedActor('pack:observed-gate', gatePack('block'));
    // no bus, no registry passed; a full pass cycle returns effects without throwing.
    await expect(a.receive(env('tool_call', pass))).resolves.toBeInstanceOf(Array);
  });
});
