/** integration_gate — injected seams only (no real git / gh / .opensquid). */
import { describe, it, expect } from 'vitest';
import { integrateItem, itemCommitOnTarget, type GateIo } from './integration_gate.js';
import type { IntegrationPlan } from './version_control.js';
import type { StageIo } from './stage_integration.js';
import type { GhIo } from './stage_pr.js';
import { integrationPlan, resolveEnvironments } from './version_control.js';

function plan(hasStage: boolean): IntegrationPlan {
  const r = resolveEnvironments(
    hasStage
      ? { production: 'main', staging: 'stage', local: 'local' }
      : { production: 'main', local: 'local' },
  );
  if (!r.ok) throw new Error(r.reason);
  return integrationPlan(r.environments);
}

function stageIo(ok = true): StageIo {
  return {
    ensureBranch: () => Promise.resolve(),
    ensureWorktree: () => Promise.resolve(),
    mergeNoFf: () => (ok ? Promise.resolve() : Promise.reject(new Error('conflict'))),
    abortMerge: () => Promise.resolve(),
    resetHard: () => Promise.resolve(),
    runSuite: () => Promise.resolve(ok),
    tagPush: () => Promise.resolve(),
  };
}

function gh(ok = true): GhIo {
  return {
    ghAuthOk: () => Promise.resolve(ok),
    prCreate: () => Promise.resolve('https://example/pr/1'),
    latestPrefixTag: () => Promise.resolve(null),
    tagPush: () => Promise.resolve(),
  };
}

function gate(reachable = true): GateIo {
  return {
    isReachable: () => Promise.resolve(reachable),
    revParse: () => Promise.resolve('abc'),
  };
}

describe('itemCommitOnTarget', () => {
  it('false on empty commit', async () => {
    expect(await itemCommitOnTarget('', 'stage', '/r', gate())).toBe(false);
  });
  it('delegates reachability', async () => {
    expect(await itemCommitOnTarget('deadbeef', 'stage', '/r', gate(true))).toBe(true);
    expect(await itemCommitOnTarget('deadbeef', 'stage', '/r', gate(false))).toBe(false);
  });
});

describe('integrateItem — has-stage vs no-stage', () => {
  it('has-stage: merge + reachable + PR → ok', async () => {
    const r = await integrateItem({
      plan: plan(true),
      itemCommit: 'deadbeef',
      cwd: '/repo',
      stageIo: stageIo(true),
      ghIo: gh(true),
      gateIo: gate(true),
    });
    expect(r).toMatchObject({ ok: true, target: 'stage', prUrl: 'https://example/pr/1' });
  });

  it('has-stage: merge fail → not ok (fail-visible)', async () => {
    const r = await integrateItem({
      plan: plan(true),
      itemCommit: 'deadbeef',
      cwd: '/repo',
      stageIo: stageIo(false),
      ghIo: gh(true),
      gateIo: gate(true),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/integration-failed/);
  });

  it('no-stage: skip merge; unreachable commit → not ok', async () => {
    const r = await integrateItem({
      plan: plan(false),
      itemCommit: 'deadbeef',
      cwd: '/repo',
      ghIo: gh(true),
      gateIo: gate(false),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not reachable on local/);
  });

  it('no-stage: reachable + PR → ok', async () => {
    const r = await integrateItem({
      plan: plan(false),
      itemCommit: 'deadbeef',
      cwd: '/repo',
      ghIo: gh(true),
      gateIo: gate(true),
    });
    expect(r).toMatchObject({ ok: true, target: 'local' });
  });

  it('empty item commit → not ok', async () => {
    const r = await integrateItem({
      plan: plan(false),
      itemCommit: '',
      cwd: '/repo',
      ghIo: gh(true),
      gateIo: gate(true),
    });
    expect(r.ok).toBe(false);
  });
});
