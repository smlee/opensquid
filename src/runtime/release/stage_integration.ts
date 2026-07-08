/**
 * Role: land a source branch onto the configured staging branch in staging's OWN context.
 * Context: staging branch name from version-control.environments; mainRoot + StageIo.
 * Constraints: NEVER checkout/merge/reset on the main working tree; create-if-absent staging;
 *   invoked ONLY when staging is configured (caller-gated). Conflict/red → no integration.
 * Output: { integrated: boolean }.
 *
 * Fix: destructive ops (checkout/merge/resetHard) run in a dedicated stage worktree under
 * `<mainRoot>/.opensquid/git/stage-wt`, not `cwd = mainRoot`.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const execFileP = promisify(execFile);

/** @deprecated Prefer the configured environments.staging name; kept for test fixtures. */
export const STAGE_BRANCH = 'stage';

/** Injectable git + suite effects for stage integration. */
export interface StageIo {
  /** Ensure `branch` exists (create from startPoint if absent). Runs in mainRoot. */
  ensureBranch: (branch: string, startPoint: string, mainRoot: string) => Promise<void>;
  /** Ensure a worktree for `branch` at `path` (create or reuse). Runs in mainRoot. */
  ensureWorktree: (path: string, branch: string, mainRoot: string) => Promise<void>;
  /** `git merge --no-ff <branch>` in stageCwd (throws on conflict). */
  mergeNoFf: (branch: string, stageCwd: string) => Promise<void>;
  abortMerge: (stageCwd: string) => Promise<void>;
  /** Roll back last commit in stageCwd only (never mainRoot). */
  resetHard: (ref: string, stageCwd: string) => Promise<void>;
  runSuite: (stageCwd: string) => Promise<boolean>;
  tagPush: (tag: string, stageCwd: string) => Promise<void>;
  /** Optional push of the staging branch after green integrate. */
  pushBranch?: (branch: string, mainRoot: string) => Promise<void>;
}

export const realStageIo: StageIo = {
  ensureBranch: async (branch, startPoint, mainRoot) => {
    const exists = await execFileP('git', ['rev-parse', '--verify', branch], { cwd: mainRoot })
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      await execFileP('git', ['branch', branch, startPoint], { cwd: mainRoot });
    }
  },
  ensureWorktree: async (path, branch, mainRoot) => {
    // Reuse if already registered; otherwise add.
    const listed = await execFileP('git', ['worktree', 'list', '--porcelain'], { cwd: mainRoot })
      .then((r) => r.stdout)
      .catch(() => '');
    if (listed.includes(path)) return;
    await execFileP('git', ['worktree', 'add', path, branch], { cwd: mainRoot });
  },
  mergeNoFf: async (branch, stageCwd) => {
    await execFileP('git', ['merge', '--no-ff', '--no-edit', branch], { cwd: stageCwd });
  },
  abortMerge: async (stageCwd) => {
    await execFileP('git', ['merge', '--abort'], { cwd: stageCwd }).catch(() => undefined);
  },
  resetHard: async (ref, stageCwd) => {
    await execFileP('git', ['reset', '--hard', ref], { cwd: stageCwd });
  },
  runSuite: async (stageCwd) =>
    execFileP('bash', ['scripts/pre-push.sh'], { cwd: stageCwd })
      .then(() => true)
      .catch(() => false),
  tagPush: async (tag, stageCwd) => {
    await execFileP('git', ['tag', tag], { cwd: stageCwd });
    await execFileP('git', ['push', 'origin', tag], { cwd: stageCwd });
  },
  pushBranch: async (branch, mainRoot) => {
    await execFileP('git', ['push', '-u', 'origin', branch], { cwd: mainRoot });
  },
};

export interface MergeToStageOpts {
  sourceBranch: string;
  stagingBranch: string;
  /** null → skip rc-tag (loop path may omit). */
  rcTag: string | null;
  mainRoot: string;
  io: StageIo;
  /** Override stage worktree path (default: `<mainRoot>/.opensquid/git/stage-wt`). */
  stageWorktreePath?: string;
  /** Branch start-point when creating staging (default: sourceBranch). */
  startPoint?: string;
}

/**
 * Role: merge source → staging inside the stage worktree; suite-gate; optional rc-tag.
 * Context: MergeToStageOpts (config-gated by caller — only when staging set).
 * Constraints: all checkout/merge/reset on stage worktree path, never mainRoot working tree.
 * Output: { integrated }.
 */
export async function mergeToStage(opts: MergeToStageOpts): Promise<{ integrated: boolean }> {
  const { sourceBranch, stagingBranch, rcTag, mainRoot, io } = opts;
  const stageWt = opts.stageWorktreePath ?? join(mainRoot, '.opensquid', 'git', 'stage-wt');
  const start = opts.startPoint ?? sourceBranch;

  await io.ensureBranch(stagingBranch, start, mainRoot);
  await io.ensureWorktree(stageWt, stagingBranch, mainRoot);

  const merged = await io
    .mergeNoFf(sourceBranch, stageWt)
    .then(() => true)
    .catch(() => false);
  if (!merged) {
    await io.abortMerge(stageWt);
    return { integrated: false };
  }
  if (!(await io.runSuite(stageWt))) {
    await io.resetHard('HEAD~1', stageWt); // roll back ONLY on the stage worktree
    return { integrated: false };
  }
  if (rcTag !== null && rcTag.length > 0) {
    await io.tagPush(rcTag, stageWt);
  }
  if (io.pushBranch !== undefined) {
    await io.pushBranch(stagingBranch, mainRoot).catch(() => undefined);
  }
  return { integrated: true };
}
