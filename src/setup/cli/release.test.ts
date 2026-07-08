/** AGF.6 (wg-b9c7c21cb124) — the SUPERSEDED `opensquid release` sequence, driven through injected seams (NO live
 *  git/gh). Asserts: refuse-red / refuse-behind fire BEFORE any mutation; a missing versioning config refuses; the
 *  green path integrates the branch into `stage` (rc-tagged) then opens the batched stage→main PR (never merges to
 *  main); a non-integrating merge (conflict/red) refuses; the module NEVER merges directly to main / publishes. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { runRelease, integrateBranchToStage, type ReleaseDeps } from './release.js';

interface Calls {
  stageIntegrate: unknown[][];
  openPr: unknown[][];
}
function deps(over: Partial<ReleaseDeps> = {}): ReleaseDeps & { calls: Calls } {
  const calls: Calls = { stageIntegrate: [], openPr: [] };
  const base: ReleaseDeps = {
    currentBranch: () => Promise.resolve('feat/x'),
    suiteGreen: () => Promise.resolve(true),
    upToDateWithMain: () => Promise.resolve(true),
    versioning: () =>
      Promise.resolve({ strategy: 'locked-prefix', prefix: '0.5', bump: 'patch-per-release' }),
    prefixTag: () => Promise.resolve('v0.5.547'),
    rcTagsFor: () => Promise.resolve([]),
    stageIntegrate: (branch, rcTag, cwd) => {
      calls.stageIntegrate.push([branch, rcTag, cwd]);
      return Promise.resolve({ integrated: true });
    },
    openPr: (title, body, cwd) => {
      calls.openPr.push([title, body, cwd]);
      return Promise.resolve({ url: 'https://example/pr/1' });
    },
    ...over,
  };
  return Object.assign(base, { calls });
}

describe('AGF.6 precondition (refuse-red / refuse-behind / no versioning)', () => {
  it('a RED suite → non-zero exit, NO integrate/PR side effect', async () => {
    const d = deps({ suiteGreen: () => Promise.resolve(false) });
    expect(await runRelease('/repo', d)).not.toBe(0);
    expect(d.calls.stageIntegrate).toHaveLength(0);
    expect(d.calls.openPr).toHaveLength(0);
  });

  it('BEHIND main → non-zero exit, NO integrate', async () => {
    const d = deps({ upToDateWithMain: () => Promise.resolve(false) });
    expect(await runRelease('/repo', d)).not.toBe(0);
    expect(d.calls.stageIntegrate).toHaveLength(0);
  });

  it('a MISSING versioning config → refuses (no naive-semver fallback — that path is superseded)', async () => {
    const d = deps({ versioning: () => Promise.resolve(null) });
    expect(await runRelease('/repo', d)).not.toBe(0);
    expect(d.calls.stageIntegrate).toHaveLength(0);
  });
});

describe('AGF.6 happy path (green + up-to-date + versioning): stage → PR, never main', () => {
  it('integrates the branch into stage (rc-tagged) then opens the batched stage→main PR', async () => {
    const d = deps();
    expect(await runRelease('/repo', d)).toBe(0);
    expect(d.calls.stageIntegrate).toHaveLength(1);
    // rc tag = nextLockedTag(0.5, v0.5.547) = 0.5.548, first rc → v0.5.548-rc.1
    expect(d.calls.stageIntegrate[0]).toEqual(['feat/x', 'v0.5.548-rc.1', '/repo']);
    expect(d.calls.openPr).toHaveLength(1);
    expect((d.calls.openPr[0] as string[])[0]).toMatch(/stage.*main|Release/i);
  });

  it('the rc counter advances past an existing rc (single-writer on stage)', async () => {
    const d = deps({ rcTagsFor: () => Promise.resolve(['v0.5.548-rc.1', 'v0.5.548-rc.2']) });
    expect(await runRelease('/repo', d)).toBe(0);
    expect(d.calls.stageIntegrate[0]?.[1]).toBe('v0.5.548-rc.3');
  });
});

describe('AGF.6 non-integrating merge (conflict / red on merge) → refuse, no PR', () => {
  it('a merge that did NOT integrate refuses and opens NO PR', async () => {
    const d = deps({ stageIntegrate: () => Promise.resolve({ integrated: false }) });
    // the spy above is overridden; assert via exit code + no PR
    expect(await runRelease('/repo', d)).not.toBe(0);
    expect(d.calls.openPr).toHaveLength(0);
  });
});

describe('AGF.5+AGF.6 integrateBranchToStage — the SSOT the loop onShipped fold reuses (no precondition)', () => {
  it('integrates the given branch (rc-tagged) then opens the batched PR — returns the url + base', async () => {
    const d = deps();
    const r = await integrateBranchToStage('auto/wg-abc', '/repo', d);
    expect(r.integrated).toBe(true);
    expect(r.rcTag).toBe('v0.5.548-rc.1');
    expect(r.base).toBe('0.5.548');
    expect(r.url).toBe('https://example/pr/1');
    expect(d.calls.stageIntegrate[0]).toEqual(['auto/wg-abc', 'v0.5.548-rc.1', '/repo']);
    expect(d.calls.openPr).toHaveLength(1);
  });

  it('a non-automated project (no versioning) SKIPS (reason no-versioning), no integrate/PR', async () => {
    const d = deps({ versioning: () => Promise.resolve(null) });
    const r = await integrateBranchToStage('auto/wg-abc', '/repo', d);
    expect(r).toEqual({ integrated: false, reason: 'no-versioning' });
    expect(d.calls.stageIntegrate).toHaveLength(0);
    expect(d.calls.openPr).toHaveLength(0);
  });

  it('a non-integrating merge (conflict/red) returns not-integrated + opens NO PR', async () => {
    const d = deps({ stageIntegrate: () => Promise.resolve({ integrated: false }) });
    const r = await integrateBranchToStage('auto/wg-abc', '/repo', d);
    expect(r.integrated).toBe(false);
    expect(r.reason).toBe('not-integrated');
    expect(d.calls.openPr).toHaveLength(0);
  });
});

describe('AGF.6 SUPERSEDES the direct-merge-to-main + naive semver', () => {
  it('the module never merges directly to main, never bumps intent-from-commit, never publishes', () => {
    const src = readFileSync(join(__dirname, 'release.ts'), 'utf8');
    expect(src).not.toMatch(/mergeToMain/); // no direct merge to main (superseded)
    expect(src).not.toMatch(/bumpLevel|nextVersion\b/); // no intent-from-commit semver (superseded)
    expect(src).not.toMatch(/execFileP\(\s*'npm'|'publish'/); // no npm-publish invocation in the local command
    expect(src).not.toMatch(/gh['"\s,]*pr['"\s,]*merge|pr merge/); // never auto-merges the PR (the human gate)
  });
});
