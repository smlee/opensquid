/**
 * Tests for stage_context (#6) — the CHECKPOINT renderer + per-stage WORK-CONTEXT. Pure over injected readers.
 */
import { describe, expect, it } from 'vitest';

import type { FsmStateFile } from '../runtime/fsm_state.js';

import { renderCheckpoint, stageWorkContext, type WorkContextDeps } from './stage_context.js';

describe('renderCheckpoint', () => {
  it('renders the current stage + the history path', () => {
    const fsm: FsmStateFile = {
      state: 'author',
      started_at: '2026-06-29T00:00:00.000Z',
      history: [
        { state: 'scope', at: 't1' },
        { state: 'plan', at: 't2' },
        { state: 'author', at: 't3' },
      ],
    };
    const c = renderCheckpoint(fsm);
    expect(c).toContain('stage: author');
    expect(c).toContain('scope → plan → author');
  });

  it('is empty when there is no FSM state', () => {
    expect(renderCheckpoint(null)).toBe('');
  });
});

const deps = (over: Partial<WorkContextDeps> = {}): WorkContextDeps => ({
  goal: async () => 'ship v2',
  scopePath: async () => 'docs/research/x-pre-research-2026-06-29.md',
  plan: async () => 'ISSUES:\n- I1: do it',
  task: async () => ({ id: '1', subject: 'do the thing', taskId: 'GFR.1' }),
  acceptance: async () => 'waiting',
  ...over,
});

describe('stageWorkContext — the per-stage input pointer', () => {
  it('scope → the goal', async () => {
    expect(await stageWorkContext('scope', 's', deps())).toContain('ship v2');
  });
  it('plan → the scope artifact to decompose', async () => {
    expect(await stageWorkContext('plan', 's', deps())).toContain('pre-research');
  });
  it('author → the plan', async () => {
    expect(await stageWorkContext('author', 's', deps())).toContain('I1: do it');
  });
  it('code → the active task (id + subject)', async () => {
    const c = await stageWorkContext('code', 's', deps());
    expect(c).toContain('GFR.1');
    expect(c).toContain('do the thing');
  });
  it('deploy → acceptance status', async () => {
    expect(await stageWorkContext('deploy', 's', deps())).toContain('waiting');
  });
  it('an absent input → empty slot (drops out of the bundle)', async () => {
    expect(await stageWorkContext('scope', 's', deps({ goal: async () => null }))).toBe('');
  });
  it('a terminal/decision/unknown stage → empty', async () => {
    expect(await stageWorkContext('done', 's', deps())).toBe('');
  });
});
