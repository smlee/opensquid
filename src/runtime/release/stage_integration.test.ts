/** mergeToStage — staging worktree context; stubbed StageIo — NO real git. */
import { describe, it, expect } from 'vitest';
import { mergeToStage, type StageIo } from './stage_integration.js';

function io(over: Partial<StageIo> = {}): StageIo & { log: string[] } {
  const log: string[] = [];
  const base: StageIo = {
    ensureBranch: (b, start, root) => (
      log.push(`ensureBranch:${b}:${start}@${root}`),
      Promise.resolve()
    ),
    ensureWorktree: (path, b, root) => (
      log.push(`ensureWorktree:${path}:${b}@${root}`),
      Promise.resolve()
    ),
    mergeNoFf: (b, stageCwd) => (log.push(`merge:${b}@${stageCwd}`), Promise.resolve()),
    abortMerge: (stageCwd) => (log.push(`abort@${stageCwd}`), Promise.resolve()),
    resetHard: (ref, stageCwd) => (log.push(`reset:${ref}@${stageCwd}`), Promise.resolve()),
    runSuite: (stageCwd) => (log.push(`suite@${stageCwd}`), Promise.resolve(true)),
    tagPush: (t, stageCwd) => (log.push(`tag:${t}@${stageCwd}`), Promise.resolve()),
    ...over,
  };
  return Object.assign(base, { log });
}

describe('mergeToStage — stage worktree context (never main checkout)', () => {
  it('clean merge + green suite → integrated; ops use stage-wt path not mainRoot alone', async () => {
    const i = io();
    const r = await mergeToStage({
      sourceBranch: 'local',
      stagingBranch: 'stage',
      rcTag: 'v0.5.11-rc.1',
      mainRoot: '/repo',
      io: i,
    });
    expect(r).toEqual({ integrated: true });
    expect(i.log).toContain('ensureBranch:stage:local@/repo');
    expect(i.log.some((l) => l.includes('stage-wt'))).toBe(true);
    expect(i.log).toContain('merge:local@/repo/.opensquid/git/stage-wt');
    expect(i.log).toContain('suite@/repo/.opensquid/git/stage-wt');
    expect(i.log).toContain('tag:v0.5.11-rc.1@/repo/.opensquid/git/stage-wt');
    // no bare checkout of stage on mainRoot
    expect(i.log.some((l) => l === 'checkout:stage')).toBe(false);
  });

  it('conflict → abort on stage-wt, not integrated', async () => {
    const i = io({
      mergeNoFf: () => Promise.reject(new Error('conflict')),
    });
    const r = await mergeToStage({
      sourceBranch: 'local',
      stagingBranch: 'stage',
      rcTag: null,
      mainRoot: '/repo',
      io: i,
    });
    expect(r).toEqual({ integrated: false });
    expect(i.log.some((l) => l.startsWith('abort@'))).toBe(true);
    expect(i.log.some((l) => l.startsWith('tag:'))).toBe(false);
  });

  it('red suite → resetHard HEAD~1 on stage-wt only', async () => {
    const i = io({ runSuite: () => Promise.resolve(false) });
    const r = await mergeToStage({
      sourceBranch: 'local',
      stagingBranch: 'stage',
      rcTag: 'v0.5.11-rc.1',
      mainRoot: '/repo',
      io: i,
    });
    expect(r).toEqual({ integrated: false });
    expect(i.log).toContain('reset:HEAD~1@/repo/.opensquid/git/stage-wt');
    expect(i.log.some((l) => l.startsWith('tag:'))).toBe(false);
  });
});
