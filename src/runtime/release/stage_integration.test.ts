/** AGF.5 (wg-72134554548f) + GF.4 (wg-e20fb6b080e0) — mergeToStage: merge a semantic local branch → persistent `stage`,
 *  suite-gate, rc-tag on green. A conflict (abort) or a red suite (reset HEAD~1) → NO integration, NO tag, stage
 *  left green. GF.4: the DESTRUCTIVE ops (merge/reset/tag) run in the staging branch's OWN worktree, NEVER the
 *  main working tree (the work-loss fix). Stubbed StageIo — NO real git. */
import { describe, it, expect } from 'vitest';
import { mergeToStage, type StageIo } from './stage_integration.js';

const MAIN_ROOT = '/repo/main';
const STAGE_WT = '/tmp/wt-stage'; // the fixed fake worktree path worktreeAddOrReuse returns

/** A stubbed StageIo whose `log` records each op with the cwd it was invoked with. `destructiveCwds` captures the
 *  cwd of ONLY the destructive ops (mergeNoFf, resetHard, tagPush) — the GF.4 work-loss guard. */
function io(over: Partial<StageIo> = {}): StageIo & { log: string[]; destructiveCwds: string[] } {
  const log: string[] = [];
  const destructiveCwds: string[] = [];
  const base: StageIo = {
    checkout: (ref, cwd) => (log.push(`checkout:${ref}@${cwd}`), Promise.resolve()),
    mergeNoFf: (b, cwd) => (
      log.push(`merge:${b}@${cwd}`),
      destructiveCwds.push(cwd),
      Promise.resolve()
    ),
    abortMerge: (cwd) => (log.push(`abort@${cwd}`), Promise.resolve()),
    resetHard: (ref, cwd) => (
      log.push(`reset:${ref}@${cwd}`),
      destructiveCwds.push(cwd),
      Promise.resolve()
    ),
    branchExists: () => Promise.resolve(true), // default: `stage` already exists (existing-tree case)
    createBranch: (b, base, cwd) => (log.push(`create:${b}:${base}@${cwd}`), Promise.resolve()),
    runSuite: (cwd) => (log.push(`suite@${cwd}`), Promise.resolve(true)),
    tagPush: (t, cwd) => (
      log.push(`tag:${t}@${cwd}`),
      destructiveCwds.push(cwd),
      Promise.resolve()
    ),
    worktreeAddOrReuse: (_branch, _wtPath, _mainRoot) => Promise.resolve(STAGE_WT),
    worktreeRemove: () => Promise.resolve(),
    ...over,
  };
  return Object.assign(base, { log, destructiveCwds });
}

describe('AGF.5 mergeToStage', () => {
  it('clean merge + green suite → { integrated:true }, rc-tag pushed on the one stage branch', async () => {
    const i = io();
    const r = await mergeToStage(
      'feat/improve-deploy-policy',
      'stage',
      'v0.5.11-rc.1',
      MAIN_ROOT,
      i,
    );
    expect(r).toEqual({ integrated: true });
    expect(i.log).toEqual([
      `merge:feat/improve-deploy-policy@${STAGE_WT}`,
      `suite@${STAGE_WT}`,
      `tag:v0.5.11-rc.1@${STAGE_WT}`,
    ]);
  });

  it('when staging does NOT exist → cut it from the configured production branch', async () => {
    const i = io({ branchExists: () => Promise.resolve(false) });
    const r = await mergeToStage(
      'feat/improve-deploy-policy',
      'stage',
      'v0.5.11-rc.1',
      MAIN_ROOT,
      i,
      'production',
    );
    expect(r).toEqual({ integrated: true });
    // create-if-absent runs in mainRoot (non-destructive `git branch`), the merge/suite/tag in the worktree.
    expect(i.log).toEqual([
      `create:stage:production@${MAIN_ROOT}`,
      `merge:feat/improve-deploy-policy@${STAGE_WT}`,
      `suite@${STAGE_WT}`,
      `tag:v0.5.11-rc.1@${STAGE_WT}`,
    ]);
  });

  it('a CONFLICT (mergeNoFf throws) → abort, { integrated:false }, NO suite, NO tag', async () => {
    const i = io({ mergeNoFf: () => Promise.reject(new Error('conflict')) });
    const r = await mergeToStage(
      'feat/improve-deploy-policy',
      'stage',
      'v0.5.11-rc.1',
      MAIN_ROOT,
      i,
    );
    expect(r).toEqual({ integrated: false });
    expect(i.log.some((l) => l.startsWith('abort@'))).toBe(true);
    expect(i.log.some((l) => l.startsWith('suite@'))).toBe(false);
    expect(i.log.some((l) => l.startsWith('tag:'))).toBe(false);
  });

  it('a RED suite after a clean merge → reset HEAD~1 (rolled back), { integrated:false }, NO tag — stage stays green', async () => {
    const i = io({ runSuite: () => Promise.resolve(false) });
    const r = await mergeToStage(
      'feat/improve-deploy-policy',
      'stage',
      'v0.5.11-rc.1',
      MAIN_ROOT,
      i,
    );
    expect(r).toEqual({ integrated: false });
    expect(i.log.some((l) => l === `reset:HEAD~1@${STAGE_WT}`)).toBe(true);
    expect(i.log.some((l) => l.startsWith('tag:'))).toBe(false);
  });

  // GF.4 HEADLINE — the WORK-LOSS GUARD. Every destructive op (merge, reset, tag) MUST run with cwd === the
  // staging worktree, NEVER the main working tree. The original bug ran `merge` + `reset --hard HEAD~1` in
  // `mainRoot`, resetting the loop branch's checkout = work-loss. Force the red-suite path so `resetHard` fires,
  // so all three destructive ops are exercised in one run.
  it('GF.4: EVERY destructive op runs in the staging worktree, NEVER mainRoot (the work-loss guard)', async () => {
    const i = io({ runSuite: () => Promise.resolve(false) }); // red suite → exercise resetHard too
    await mergeToStage('feat/improve-deploy-policy', 'stage', 'v0.5.11-rc.1', MAIN_ROOT, i);
    // merge + reset captured (tag is skipped on a red suite, so at least these two destructive ops ran).
    expect(i.destructiveCwds.length).toBeGreaterThanOrEqual(2);
    for (const cwd of i.destructiveCwds) {
      expect(cwd).toBe(STAGE_WT);
      expect(cwd).not.toBe(MAIN_ROOT);
    }
  });

  it('GF.4: on the GREEN path the rc-tag push also runs in the staging worktree, NEVER mainRoot', async () => {
    const i = io();
    await mergeToStage('feat/improve-deploy-policy', 'stage', 'v0.5.11-rc.1', MAIN_ROOT, i);
    // green path exercises merge + tag as destructive ops — both in the worktree, none in mainRoot.
    expect(i.destructiveCwds.length).toBeGreaterThanOrEqual(2);
    for (const cwd of i.destructiveCwds) {
      expect(cwd).toBe(STAGE_WT);
      expect(cwd).not.toBe(MAIN_ROOT);
    }
  });
});
