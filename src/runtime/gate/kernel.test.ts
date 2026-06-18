/** KERN.1 — gate-action kernel. */
import { describe, expect, it } from 'vitest';

import { Bus } from '../bus/bus.js';
import { applyAction, type GateCtx } from './kernel.js';

const ctx = (over: Partial<GateCtx> = {}): GateCtx => ({ bus: new Bus(), from: 'gate', ...over });
const MESSAGES = { size_too_big: 'Code-split X and re-run.' };

describe('gate-action kernel (KERN.1)', () => {
  it('pass proceeds (exit 0) and publishes NOTHING', () => {
    const c = ctx();
    const eff = applyAction('pass', 'whatever', MESSAGES, c);
    expect(eff).toEqual({ exitCode: 0 });
    expect(c.bus.since(0).events).toHaveLength(0);
  });

  it('warn proceeds (exit 0) with the advisory message', () => {
    const eff = applyAction('warn', 'size_too_big', MESSAGES, ctx());
    expect(eff).toMatchObject({ exitCode: 0, message: 'Code-split X and re-run.' });
  });

  it('block denies (exit 2) and injects the failure-typed instruction (self-continue)', () => {
    const eff = applyAction('block', 'size_too_big', MESSAGES, ctx());
    expect(eff).toMatchObject({ exitCode: 2, message: 'Code-split X and re-run.' });
    expect(eff.verdict).toBeUndefined();
  });

  it('halt → WEDGE; with humanRequired → HUMAN_REQUIRED', () => {
    expect(applyAction('halt', 'x', MESSAGES, ctx()).verdict).toBe('WEDGE');
    expect(applyAction('halt', 'x', MESSAGES, ctx({ humanRequired: true })).verdict).toBe(
      'HUMAN_REQUIRED',
    );
  });

  it('an unknown failure type → a safe default message (never throws)', () => {
    expect(applyAction('block', 'no_such_key', MESSAGES, ctx()).message).toBe('gate:block');
  });

  it('every NON-pass action publishes a gate_action transition (INV2 — enforcement is observable)', () => {
    const c = ctx();
    applyAction('block', 'size_too_big', MESSAGES, c);
    const { events } = c.bus.since(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'gate_action',
      payload: { action: 'block', failureType: 'size_too_big' },
    });
  });
});
