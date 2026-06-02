/**
 * T-PACK-FSM-STANDARDIZATION slice A3 — fsm_state persistence tests.
 *
 * Uses the vitest-provided OPENSQUID_HOME temp dir (globalSetup) so
 * sessionStateFile writes land in an isolated tree.
 */
import { describe, expect, it } from 'vitest';

import type { Fsm } from './fsm.js';
import { readFsmState, advanceFsmState, clearFsmState } from './fsm_state.js';

const FSM: Fsm = {
  initial: 'idle',
  states: ['idle', 'researching', 'building'],
  transitions: [
    { from: 'idle', on: 'start', to: 'researching' },
    // loop-back: stay in researching while guesses remain
    { from: 'researching', on: 'guess_found', to: 'researching' },
    { from: 'researching', on: 'guess_free', to: 'building', when: 'ok' },
  ],
};

let n = 0;
const sid = (): string => `fsm-state-test-${String(n++)}`;
const NOW = '2026-06-02T00:00:00.000Z';

describe('fsm_state', () => {
  it('reads the initial state when nothing is persisted', async () => {
    expect(await readFsmState(sid(), 'p', FSM)).toBe('idle');
  });

  it('advances on a matching event and persists the new state', async () => {
    const s = sid();
    const r = await advanceFsmState(s, 'p', FSM, 'start', NOW);
    expect(r).toMatchObject({ next: 'researching', transitioned: true });
    expect(await readFsmState(s, 'p', FSM)).toBe('researching');
  });

  it('is a no-op for an event with no matching transition (state unchanged)', async () => {
    const s = sid();
    await advanceFsmState(s, 'p', FSM, 'start', NOW);
    const r = await advanceFsmState(s, 'p', FSM, 'nonsense', NOW);
    expect(r.transitioned).toBe(false);
    expect(await readFsmState(s, 'p', FSM)).toBe('researching');
  });

  it('honors a `when` guard via evalWhen (blocked → stays; allowed → advances)', async () => {
    const s = sid();
    await advanceFsmState(s, 'p', FSM, 'start', NOW);
    const blocked = await advanceFsmState(s, 'p', FSM, 'guess_free', NOW, () => false);
    expect(blocked.transitioned).toBe(false);
    expect(await readFsmState(s, 'p', FSM)).toBe('researching');
    const allowed = await advanceFsmState(s, 'p', FSM, 'guess_free', NOW, () => true);
    expect(allowed.transitioned).toBe(true);
    expect(await readFsmState(s, 'p', FSM)).toBe('building');
  });

  it('a loop-back self-transition appends history but keeps the state', async () => {
    const s = sid();
    await advanceFsmState(s, 'p', FSM, 'start', NOW);
    // researching --guess_found--> researching: a real declared transition to
    // the SAME state → step reports transitioned:false (no state change), so it
    // is treated as a no-op for persistence.
    const r = await advanceFsmState(s, 'p', FSM, 'guess_found', NOW);
    expect(r.via).not.toBeNull();
    expect(r.transitioned).toBe(false);
    expect(await readFsmState(s, 'p', FSM)).toBe('researching');
  });

  it('multiple packs keep independent state in one session', async () => {
    const s = sid();
    await advanceFsmState(s, 'pack-a', FSM, 'start', NOW);
    expect(await readFsmState(s, 'pack-a', FSM)).toBe('researching');
    expect(await readFsmState(s, 'pack-b', FSM)).toBe('idle');
  });

  it('clearFsmState removes the file (read falls back to initial)', async () => {
    const s = sid();
    await advanceFsmState(s, 'p', FSM, 'start', NOW);
    await clearFsmState(s, 'p');
    expect(await readFsmState(s, 'p', FSM)).toBe('idle');
    // idempotent: clearing again does not throw
    await clearFsmState(s, 'p');
  });
});
