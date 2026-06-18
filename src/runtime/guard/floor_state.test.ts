/** P0.3 — Progress-floor counter persistence + EFSM serialization round-trip. */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { ProgressFloor, type FloorCounters } from './progress_floor.js';
import { loadFloorState, saveFloorState } from './floor_state.js';

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'osq-floor-'));
  process.env.OPENSQUID_HOME = home;
});

describe('ProgressFloor serialization (P0.3)', () => {
  it('seed = snapshot identity: new ProgressFloor(s).snapshot() round-trips s', () => {
    const s: FloorCounters = {
      exact: { 'a:1': 3 },
      sameTool: { bash: 5 },
      noProgress: { 'r:x': 2 },
    };
    expect(new ProgressFloor(s).snapshot()).toEqual(s);
  });

  it('a default ProgressFloor snapshots to empty counters', () => {
    expect(new ProgressFloor().snapshot()).toEqual({ exact: {}, sameTool: {}, noProgress: {} });
  });

  it('a seeded floor continues counting from the seed (observe sees prior state)', () => {
    // seed exact=4 for one signature; the 5th identical failure → block
    const floor = new ProgressFloor({ exact: { sig: 4 }, sameTool: { t: 4 }, noProgress: {} });
    expect(
      floor.observe({ tool: 't', argsHash: 'sig', failed: true, idempotentSameResult: false }),
    ).toBe('block'); // exact reached 5
  });
});

describe('floor_state persistence (P0.3)', () => {
  it('save then load round-trips the counters', async () => {
    const s: FloorCounters = { exact: { 'a:1': 2 }, sameTool: { edit: 3 }, noProgress: {} };
    await saveFloorState('sess', s);
    expect(await loadFloorState('sess')).toEqual(s);
  });

  it('absent state ⇒ empty counters (never throws)', async () => {
    expect(await loadFloorState('never-written')).toEqual({
      exact: {},
      sameTool: {},
      noProgress: {},
    });
  });
});
