/**
 * Tests for `isStrandedScoping` (RTC.4, wg-3d175ec06767) — the conservative triple-gate that
 * detects an orphaned coding-flow scoping at SessionStart(resume) without ever flagging a live one.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { atomicWriteFile } from '../atomic_write.js';
import { advanceFsmState } from '../fsm_state.js';
import { loadPack } from '../../packs/loader.js';
import { sessionStateFile } from '../paths.js';
import { appendTool } from '../session_state.js';
import { isStrandedScoping } from './stranded_scoping.js';

const OLD = '2026-06-14T00:00:00.000Z'; // FSM started here
const NOW = '2026-06-14T12:00:00.000Z'; // resume 12h later → stale (> 6h)

describe('isStrandedScoping', () => {
  let home: string;
  let prior: string | undefined;
  beforeEach(async () => {
    prior = process.env.OPENSQUID_HOME;
    home = await mkdtemp(join(tmpdir(), 'opensquid-stranded-'));
    process.env.OPENSQUID_HOME = home;
  });
  afterEach(async () => {
    if (prior === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = prior;
    await rm(home, { recursive: true, force: true });
  });

  async function armScoping(sid: string, at: string): Promise<void> {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    await advanceFsmState(sid, 'coding-flow', pack.fsm!, 'scope_start', at); // idle → scoping, started_at=at
  }

  it('stale scoping (old started_at, no turn activity, no artifacts) → true', async () => {
    await armScoping('s1', OLD);
    expect(await isStrandedScoping('s1', NOW)).toBe(true);
  });

  it('recent scoping (started_at ~ resume) → false', async () => {
    await armScoping('s2', NOW);
    expect(await isStrandedScoping('s2', NOW)).toBe(false);
  });

  it('idle (never armed) → false', async () => {
    expect(await isStrandedScoping('s3', NOW)).toBe(false);
  });

  it('stale scoping WITH recent turn activity → false (live)', async () => {
    await armScoping('s4', OLD);
    await appendTool('s4', 'Read');
    expect(await isStrandedScoping('s4', NOW)).toBe(false);
  });

  it('stale scoping WITH a work artifact (pre-research path) → false', async () => {
    await armScoping('s5', OLD);
    await atomicWriteFile(
      sessionStateFile('s5', 'coding-flow-pre-research-path'),
      JSON.stringify('/some/pre-research.md'),
    );
    expect(await isStrandedScoping('s5', NOW)).toBe(false);
  });
});
