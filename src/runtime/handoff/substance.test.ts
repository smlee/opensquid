/**
 * AHO.4 — hasResumableState: the 5 pins (the junk class is bare scoping with
 * no task and no artifact; everything genuinely resumable stays true).
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { sessionStateFile } from '../paths.js';

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
});
