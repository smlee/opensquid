/**
 * Tests for the workflow forward-map (T-FLOW-COHESION FC.2).
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CHAIN_STAGES, transitionChainStage } from './chain_state.js';
import { STAGE_NEXT, forwardMap } from './workflow_map.js';

let tempHome: string;
let prior: string | undefined;
beforeEach(async () => {
  prior = process.env.OPENSQUID_HOME;
  tempHome = await mkdtemp(join(tmpdir(), 'opensquid-flowmap-'));
  process.env.OPENSQUID_HOME = tempHome;
});
afterEach(async () => {
  if (prior === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = prior;
  await rm(tempHome, { recursive: true, force: true });
});

describe('STAGE_NEXT', () => {
  it('has a non-empty next-step for every chain stage (exhaustive, no gaps)', () => {
    for (const stage of CHAIN_STAGES) {
      expect(STAGE_NEXT[stage], `missing next-step for ${stage}`).toBeTruthy();
    }
  });
});

describe('forwardMap', () => {
  it('reports the path, current stage, and that stage’s next step', async () => {
    const sid = 'fm-1';
    await transitionChainStage(sid, 'spec_authored', { spec_path: '/abs/T-x.md' });
    const map = await forwardMap(sid);
    expect(map).toContain('Workflow: pre_research → spec → tasks → 7 phases → commit');
    expect(map).toContain('You are at: spec_authored');
    expect(map).toContain(STAGE_NEXT.spec_authored);
  });

  it('resolves to the idle map for a fresh session with no chain-state (fail-open)', async () => {
    const map = await forwardMap('never-transitioned');
    expect(map).toContain('You are at: idle');
    expect(map).toContain(STAGE_NEXT.idle);
  });

  it('reflects each stage', async () => {
    for (const stage of CHAIN_STAGES) {
      const sid = `fm-${stage}`;
      await transitionChainStage(sid, stage);
      expect(await forwardMap(sid)).toContain(`You are at: ${stage}`);
    }
  });
});
