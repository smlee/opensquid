/**
 * Tests for stage_context (#6) — the CHECKPOINT renderer + per-stage WORK-CONTEXT. Pure over injected readers.
 */
import { describe, expect, it } from 'vitest';

import type { FsmStateFile } from '../runtime/fsm_state.js';

import {
  buildStageBundle,
  interpolateDocsRoot,
  renderCheckpoint,
  stageWorkContext,
  type WorkContextDeps,
} from './stage_context.js';

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
  goal: () => Promise.resolve('ship v2'),
  scopePath: () => Promise.resolve('docs/research/x-pre-research-2026-06-29.md'),
  plan: () => Promise.resolve('ISSUES:\n- I1: do it'),
  task: () => Promise.resolve({ id: '1', subject: 'do the thing', taskId: 'GFR.1' }),
  acceptance: () => Promise.resolve('waiting'),
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
    expect(await stageWorkContext('scope', 's', deps({ goal: () => Promise.resolve(null) }))).toBe(
      '',
    );
  });
  it('a terminal/decision/unknown stage → empty', async () => {
    expect(await stageWorkContext('done', 's', deps())).toBe('');
  });
});

describe('interpolateDocsRoot — the {docsRoot} procedure-token substitution', () => {
  it('substitutes every {docsRoot} with the configured value', () => {
    const src = 'Write to `{docsRoot}/research/x.md` then `{docsRoot}/plan/y.md`.';
    expect(interpolateDocsRoot(src, '../docs')).toBe(
      'Write to `../docs/research/x.md` then `../docs/plan/y.md`.',
    );
  });

  it('the default "docs" reproduces the legacy literal (docs/research/…)', () => {
    expect(interpolateDocsRoot('to `{docsRoot}/research/x.md`', 'docs')).toBe(
      'to `docs/research/x.md`',
    );
  });

  it('content with no token is returned unchanged', () => {
    expect(interpolateDocsRoot('no token here', '../docs')).toBe('no token here');
  });
});

// buildStageBundle FAILS OPEN to the default docs-root: `si-bundle` has no session cwd → resolveDocsRoot returns
// `docs` → the scope procedure renders the legacy `docs/research/…` write path (config absent/broken is safe).
describe('buildStageBundle — {docsRoot} fails open to the legacy "docs" when no config resolves', () => {
  it('scope procedure renders docs/research/… (no {docsRoot} token leaks through)', async () => {
    const text = await buildStageBundle('si-bundle', 'fullstack-flow', {
      state: 'scope',
      started_at: '2026-06-29T00:00:00.000Z',
      history: [{ state: 'scope', at: 't1' }],
    });
    expect(text).toContain('docs/research/');
    expect(text).not.toContain('{docsRoot}');
  });
});

// PSL.2 — the 4-slot bundle is callable with ONLY (sessionId, packId, fsm): no EvalCtx, no hook event, so the
// per-stage loop (PSL.3) can prime a lap before spawning. Runs against the REAL shipped fullstack-flow files.
describe('buildStageBundle — directly callable (the per-stage loop seam)', () => {
  const fsm = (state: string): FsmStateFile => ({
    state,
    started_at: '2026-06-29T00:00:00.000Z',
    history: [{ state, at: 't1' }],
  });

  it('scope → CHECKPOINT + the scope PROCEDURE + the scope RUBRIC (audited stage)', async () => {
    const text = await buildStageBundle('si-bundle', 'fullstack-flow', fsm('scope'));
    expect(text).toContain('CHECKPOINT'); // slot 1
    expect(text).toContain('stage: scope');
    expect(text).toContain('SCOPE'); // slot 2: the procedure
    expect(text).toContain('NEVER-GUESS'); // slot 3: the scope rubric
  });

  it('deploy → the PROCEDURE but NO rubric (deploy has none)', async () => {
    const text = await buildStageBundle('si-bundle', 'fullstack-flow', fsm('deploy'));
    expect(text).toContain('DEPLOY');
    expect(text).not.toContain('NEVER-GUESS');
  });

  it('a terminal state with no procedure → empty bundle (caller injects nothing)', async () => {
    expect(await buildStageBundle('si-bundle', 'fullstack-flow', fsm('done'))).toBe('');
  });
});
