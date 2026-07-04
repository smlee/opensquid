/**
 * AHO.4 — hasResumableState: the 5 pins (the junk class is bare scoping with
 * no task and no artifact; everything genuinely resumable stays true).
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { sessionStateFile } from '../paths.js';
import { CheckpointStore } from '../durable/checkpoint_store.js';

import { hasResumableState } from './substance.js';

let home: string;
let priorHome: string | undefined;
const SID = 'substance-test-session-001';

beforeEach(async () => {
  priorHome = process.env.OPENSQUID_HOME;
  home = await mkdtemp(join(tmpdir(), 'opensquid-substance-'));
  process.env.OPENSQUID_HOME = home;
  await mkdir(join(home, 'sessions', SID, 'state'), { recursive: true });
});

afterEach(async () => {
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
  await rm(home, { recursive: true, force: true });
});

describe('hasResumableState', () => {
  it('nothing at all → false', async () => {
    expect(await hasResumableState(SID)).toBe(false);
  });

  it('bare scoping FSM, no task, no artifact → false (THE junk class)', async () => {
    await writeFile(
      sessionStateFile(SID, 'fsm-coding-flow'),
      JSON.stringify({ state: 'scoping', history: [] }),
      'utf8',
    );
    expect(await hasResumableState(SID)).toBe(false);
  });

  it('FSM beyond scoping → true', async () => {
    await writeFile(
      sessionStateFile(SID, 'fsm-coding-flow'),
      JSON.stringify({ state: 'researched', history: [] }),
      'utf8',
    );
    expect(await hasResumableState(SID)).toBe(true);
  });

  it('scoping + recorded pre-research artifact → true (cap-hit at SCOPE keeps its handoff)', async () => {
    await writeFile(
      sessionStateFile(SID, 'fsm-coding-flow'),
      JSON.stringify({ state: 'scoping', history: [] }),
      'utf8',
    );
    await writeFile(
      sessionStateFile(SID, 'coding-flow-pre-research-path'),
      JSON.stringify('/u/docs/research/T-x-pre-research-2026-06-11.md'),
      'utf8',
    );
    expect(await hasResumableState(SID)).toBe(true);
  });

  it('active task → true regardless of FSM', async () => {
    await writeFile(
      join(home, 'sessions', SID, 'active-task.json'),
      JSON.stringify({ id: '1', subject: 's', started_at: 't' }),
      'utf8',
    );
    expect(await hasResumableState(SID)).toBe(true);
  });

  it('v2 pack-agnostic: a bound checkpoint beyond scope → true with NO v1 session keys (key-drift fix)', async () => {
    // The old-bug shape: v2 writes fullstack-flow-* keys (none written here), and NONE of the v1 coding-flow-*
    // keys exist. The durable checkpoint (keyed by wg id, pack-neutral) is the resume signal handoff must see.
    const client = createClient({ url: `file:${join(home, 'opensquid.db')}` });
    const store = new CheckpointStore(client);
    await store.init();
    await store.createTaskCheckpoint('wg-substance-v2', 'plan', Date.now()); // stage beyond `scope`
    client.close();

    const prevItem = process.env.OPENSQUID_ITEM_ID;
    process.env.OPENSQUID_ITEM_ID = 'wg-substance-v2'; // resolveCheckpointKey returns this directly (lap path)
    try {
      expect(await hasResumableState(SID)).toBe(true);
    } finally {
      if (prevItem === undefined) delete process.env.OPENSQUID_ITEM_ID;
      else process.env.OPENSQUID_ITEM_ID = prevItem;
    }
  });
});
