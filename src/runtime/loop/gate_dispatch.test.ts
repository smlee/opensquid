/** FAC-CUT.5b.1 — gate_dispatch: the extracted pure gate/decision dispatch (behavior-equivalent to the
 *  former LoopDriver.runGate/runDecision; the driver.test.ts green-unchanged is the other half of the proof). */
import { describe, expect, it } from 'vitest';

import type { Fsm } from '../fsm.js';
import type { StateMeta } from '../../packs/compile_v2.js';
import {
  evalGate,
  evalDecision,
  transitionOn,
  emitOf,
  type GuardEvaluator,
} from './gate_dispatch.js';

const FSM: Fsm = {
  initial: 'g',
  states: ['g', 'next', 'a', 'b'],
  transitions: [
    { from: 'g', on: 'go', to: 'next' },
    { from: 'd', on: 'ea', to: 'a' },
    { from: 'd', on: 'eb', to: 'b' },
  ],
};
const yes: GuardEvaluator = { eval: () => true };
const no: GuardEvaluator = { eval: () => false };

describe('gate_dispatch — evalGate', () => {
  const gate = (action: 'block' | 'halt' | 'warn'): StateMeta => ({
    kind: 'gate',
    skills: [],
    guard: 'x',
    emits: 'go',
    onFail: { action, message: 'fix it' },
  });

  it('pass → advance to the emitted transition target', async () => {
    expect(await evalGate(FSM, 'g', gate('block'), yes, undefined)).toEqual({
      kind: 'advance',
      next: 'next',
    });
  });
  it('fail + block → action (ENFORCE, no advance)', async () => {
    expect(await evalGate(FSM, 'g', gate('block'), no, undefined)).toEqual({
      kind: 'action',
      action: 'block',
      message: 'fix it',
    });
  });
  it('fail + halt → action halt', async () => {
    expect(await evalGate(FSM, 'g', gate('halt'), no, undefined)).toMatchObject({
      kind: 'action',
      action: 'halt',
    });
  });
  it('fail + warn → advance + notice (proceed + nudge)', async () => {
    expect(await evalGate(FSM, 'g', gate('warn'), no, undefined)).toEqual({
      kind: 'advance',
      next: 'next',
      notice: 'fix it',
    });
  });
});

describe('gate_dispatch — evalDecision', () => {
  const dec = (): StateMeta => ({
    kind: 'decision',
    skills: [],
    branches: [
      { guard: 'first', emits: 'ea' },
      { else: true, emits: 'eb' },
    ],
  });
  it('first matching branch wins', async () => {
    expect(await evalDecision(FSM, 'd', dec(), yes, undefined)).toEqual({
      kind: 'advance',
      next: 'a',
    });
  });
  it('falls to the total else when no guard matches', async () => {
    expect(await evalDecision(FSM, 'd', dec(), no, undefined)).toEqual({
      kind: 'advance',
      next: 'b',
    });
  });
  it('throws (totality) when no branch matches and there is no else', async () => {
    const noElse: StateMeta = {
      kind: 'decision',
      skills: [],
      branches: [{ guard: 'first', emits: 'ea' }],
    };
    await expect(evalDecision(FSM, 'd', noElse, no, undefined)).rejects.toThrow(/totality/i);
  });
});

describe('gate_dispatch — transitionOn / emitOf', () => {
  it('transitionOn resolves a declared edge', () => {
    expect(transitionOn(FSM, 'g', 'go')).toBe('next');
  });
  it('transitionOn throws on a missing edge (compiler invariant)', () => {
    expect(() => transitionOn(FSM, 'g', 'nope')).toThrow(/no 'nope' transition/);
  });
  it('emitOf returns the emit event, throws when absent', () => {
    const withEmit: StateMeta = { kind: 'gate', skills: [], emits: 'go' };
    const noEmit: StateMeta = { kind: 'gate', skills: [] };
    expect(emitOf('g', withEmit)).toBe('go');
    expect(() => emitOf('g', noEmit)).toThrow(/no emit event/);
  });
});
