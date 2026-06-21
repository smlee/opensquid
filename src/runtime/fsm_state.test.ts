/**
 * T-PACK-FSM-STANDARDIZATION slice A3 — fsm_state persistence tests.
 *
 * Uses the vitest-provided OPENSQUID_HOME temp dir (globalSetup) so
 * sessionStateFile writes land in an isolated tree.
 */
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { Fsm } from './fsm.js';
import { readFsmState, advanceFsmState, clearFsmState } from './fsm_state.js';
import { recordSessionCwd, writeActiveTask } from './session_state.js';
import { readGoalMap, writeGoalMap } from './goal_map/goal_map.js';

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

// GOAL-MAPPER.2 — the per-slice trigger fires THROUGH advanceFsmState (the single
// choke-point), observe-don't-control: an advance to a worksheet-bearing state appends
// exactly one worksheet; other advances and a failing observe never alter the advance.
const FLOW: Fsm = {
  initial: 'idle',
  states: ['idle', 'scoping', 'tasks_loaded', 'building'],
  transitions: [
    { from: 'idle', on: 'scope_start', to: 'scoping' },
    { from: 'idle', on: 'task_unscoped', to: 'scoping' }, // re-arm path also lands on scoping
    { from: 'scoping', on: 'tasks', to: 'tasks_loaded' },
    { from: 'tasks_loaded', on: 'code', to: 'building' },
  ],
};

describe('fsm_state → goal-map observe (live, via the choke-point)', () => {
  let proj: string;
  const setup = async (s: string): Promise<void> => {
    proj = await mkdtemp(join(tmpdir(), 'osq-fsm-gm-'));
    await mkdir(join(proj, '.opensquid'), { recursive: true });
    await recordSessionCwd(s, proj);
    await writeGoalMap(proj, { goal: 'live goal', createdAt: NOW, claim: null, worksheets: [] });
  };
  afterEach(async () => {
    if (proj) await rm(proj, { recursive: true, force: true });
  });

  it('an advance INTO scoping appends exactly one worksheet', async () => {
    const s = sid();
    await setup(s);
    await advanceFsmState(s, 'coding-flow', FLOW, 'scope_start', NOW);
    expect((await readGoalMap(proj))?.worksheets).toHaveLength(1);
  });

  it('the re-arm path (task_unscoped → scoping) also opens a worksheet', async () => {
    const s = sid();
    await setup(s);
    await advanceFsmState(s, 'coding-flow', FLOW, 'task_unscoped', NOW);
    expect((await readGoalMap(proj))?.worksheets).toHaveLength(1);
  });

  it('a non-worksheet advance (→building) appends none', async () => {
    const s = sid();
    await setup(s);
    await advanceFsmState(s, 'coding-flow', FLOW, 'scope_start', NOW); // 1 worksheet
    await advanceFsmState(s, 'coding-flow', FLOW, 'tasks', NOW); // links taskId (none active) — no new ws
    await advanceFsmState(s, 'coding-flow', FLOW, 'code', NOW); // →building: observe no-op
    expect((await readGoalMap(proj))?.worksheets).toHaveLength(1);
  });

  it('tasks_loaded links the active taskId onto the open worksheet', async () => {
    const s = sid();
    await setup(s);
    await advanceFsmState(s, 'coding-flow', FLOW, 'scope_start', NOW);
    await writeActiveTask(s, { id: '15', subject: 's', started_at: NOW, taskId: 'GM.2' });
    await advanceFsmState(s, 'coding-flow', FLOW, 'tasks', NOW);
    expect((await readGoalMap(proj))?.worksheets[0]?.taskId).toBe('GM.2');
  });

  it('a no-match event does NOT advance and appends no worksheet', async () => {
    const s = sid();
    await setup(s);
    const r = await advanceFsmState(s, 'coding-flow', FLOW, 'nonsense', NOW);
    expect(r.transitioned).toBe(false);
    expect((await readGoalMap(proj))?.worksheets).toHaveLength(0);
  });
});
