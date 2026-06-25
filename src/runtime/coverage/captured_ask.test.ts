/**
 * CFD.2 / AD.1 — captured-ask anchor tests. Uses the vitest globalSetup OPENSQUID_HOME temp dir
 * (precedent: fsm_state.test.ts) so sessionStateFile writes land in an isolated tree; unique sid per test.
 */
import { describe, expect, it } from 'vitest';

import { appendAsk, freezeAsk, MAX_ASK, readCapturedAsk, resetAsk } from './captured_ask.js';

let n = 0;
const sid = (): string => `captured-ask-test-${String(n++)}`;

describe('captured_ask (AD.1)', () => {
  it('reads the empty default when nothing is persisted', async () => {
    expect(await readCapturedAsk(sid())).toEqual({ turns: [], frozen: false });
  });

  it('appendAsk accumulates the union of the task turns', async () => {
    const s = sid();
    await appendAsk(s, 'first ask');
    await appendAsk(s, 'second ask');
    expect(await readCapturedAsk(s)).toEqual({ turns: ['first ask', 'second ask'], frozen: false });
  });

  it('appendAsk is a no-op on an exact duplicate (no bloat on re-submit)', async () => {
    const s = sid();
    await appendAsk(s, 'same');
    await appendAsk(s, 'same');
    expect((await readCapturedAsk(s)).turns).toEqual(['same']);
  });

  it('appendAsk is a no-op once frozen (a frozen scope cannot be widened)', async () => {
    const s = sid();
    await appendAsk(s, 'in scope');
    await freezeAsk(s);
    await appendAsk(s, 'sneaked in after freeze');
    expect(await readCapturedAsk(s)).toEqual({ turns: ['in scope'], frozen: true });
  });

  it('freezeAsk is idempotent', async () => {
    const s = sid();
    await appendAsk(s, 'x');
    await freezeAsk(s);
    await freezeAsk(s);
    expect(await readCapturedAsk(s)).toEqual({ turns: ['x'], frozen: true });
  });

  it('resetAsk clears for a per-task re-arm', async () => {
    const s = sid();
    await appendAsk(s, 'old task');
    await freezeAsk(s);
    await resetAsk(s);
    expect(await readCapturedAsk(s)).toEqual({ turns: [], frozen: false });
  });

  it('appendAsk FAILS LOUD over the cap (never silently truncates the anchor)', async () => {
    const s = sid();
    await expect(appendAsk(s, 'a'.repeat(MAX_ASK + 1))).rejects.toThrow(/over cap/);
    expect(await readCapturedAsk(s)).toEqual({ turns: [], frozen: false }); // nothing written
  });
});
