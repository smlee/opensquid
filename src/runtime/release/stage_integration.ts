// src/runtime/release/stage_integration.ts — merge `auto/wg-<id>` → the persistent `stage` branch, re-run the
// suite on the merge, `rc`-tag ONLY on green. A conflict or a red suite → NO integration (roll back); the item
// re-drives from fresh `main`. SINGLE-WRITER on the one `stage` branch — items DROVE concurrently in worktrees
// (AGF.3) but integrate SERIALLY into `stage`, so the `rc` counter never races. Mirrors release_core.ts:17-42.
//
// AGF.5 (T-opensquid-automated-gitflow, wg-72134554548f). Consumed by AGF.6 (opens the PR from `stage`) + the
// orchestrator's onShipped wiring (the LIVE integration).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname } from 'node:path';

import { slugify } from '../ralph/auto_pull.js';

const execFileP = promisify(execFile);

/** The persistent integration branch — long-lived, accumulating item merges between releases (design §6). LEGACY
 *  default for the manual `opensquid release` path; the CONFIG-DRIVEN flow passes the branch name from
 *  `environments.staging` (GF.1), so no core literal `'stage'` is the flow's source of truth (GF.4). */
export const STAGE_BRANCH = 'stage';

/** The base `stage` is cut from on first use (a fresh repo / the first item after a release has no `stage` yet). */
export const STAGE_BASE_BRANCH = 'main';

/** GF.4 — the DEDICATED worktree path for a staging integration (a sibling of the main checkout, keyed by the
 *  staging branch name). The destructive merge/reset run HERE, never in the main working tree — the work-loss fix. */
function stageWorktreePath(mainRoot: string, stageBranch: string): string {
  return join(dirname(mainRoot), `.opensquid-stage-worktree-${slugify(stageBranch)}`);
}

/** Injectable git + suite effects — default binds real `execFileP('git', …)` + the full pre-push suite. */
export interface StageIo {
  checkout: (ref: string, cwd: string) => Promise<void>;
  mergeNoFf: (branch: string, cwd: string) => Promise<void>; // `git merge --no-ff <branch>` (throws on conflict)
  abortMerge: (cwd: string) => Promise<void>; // `git merge --abort`
  resetHard: (ref: string, cwd: string) => Promise<void>; // `git reset --hard <ref>`
  branchExists: (branch: string, cwd: string) => Promise<boolean>; // does the LOCAL branch exist? (`git rev-parse --verify`)
  createBranch: (branch: string, base: string, cwd: string) => Promise<void>; // `git branch <branch> <base>` — cut when absent
  runSuite: (cwd: string) => Promise<boolean>; // the full verifySuite; green === true (release.ts:52-56)
  tagPush: (tag: string, cwd: string) => Promise<void>; // `git tag <tag>` + push (tagAndPushTag shape)
  // GF.4 — the STAGING branch's OWN checkout, so the destructive ops never touch the main working tree.
  worktreeAddOrReuse: (branch: string, worktreePath: string, mainRoot: string) => Promise<string>; // idempotent `git worktree add`
  worktreeRemove: (worktreePath: string, mainRoot: string) => Promise<void>; // `git worktree remove --force`
}

/** The default real StageIo — the concrete git + suite mechanics behind the seam. */
export const realStageIo: StageIo = {
  checkout: async (ref, cwd) => {
    await execFileP('git', ['checkout', ref], { cwd });
  },
  mergeNoFf: async (branch, cwd) => {
    await execFileP('git', ['merge', '--no-ff', '--no-edit', branch], { cwd });
  },
  abortMerge: async (cwd) => {
    await execFileP('git', ['merge', '--abort'], { cwd });
  },
  resetHard: async (ref, cwd) => {
    await execFileP('git', ['reset', '--hard', ref], { cwd });
  },
  branchExists: async (branch, cwd) =>
    execFileP('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd })
      .then(() => true)
      .catch(() => false),
  createBranch: async (branch, base, cwd) => {
    await execFileP('git', ['branch', branch, base], { cwd });
  },
  runSuite: async (cwd) =>
    execFileP('bash', ['scripts/pre-push.sh'], { cwd })
      .then(() => true)
      .catch(() => false),
  tagPush: async (tag, cwd) => {
    await execFileP('git', ['tag', tag], { cwd });
    await execFileP('git', ['push', 'origin', tag], { cwd });
  },
  worktreeAddOrReuse: async (branch, worktreePath, mainRoot) => {
    // Idempotent: a long-lived staging worktree is REUSED, not re-added (mirrors the create-if-absent branch).
    const registered = await execFileP('git', ['worktree', 'list', '--porcelain'], {
      cwd: mainRoot,
    })
      .then((r) => r.stdout.includes(worktreePath))
      .catch(() => false);
    if (!registered) {
      await execFileP('git', ['worktree', 'add', worktreePath, branch], { cwd: mainRoot });
    }
    return worktreePath;
  },
  worktreeRemove: async (worktreePath, mainRoot) => {
    await execFileP('git', ['worktree', 'remove', '--force', worktreePath], {
      cwd: mainRoot,
    }).catch(() => undefined); // fail-open teardown
  },
};

/** Merge `branch` into the persistent `stage` branch (`--no-ff`, a real integration commit), gate on the suite,
 *  and `rc`-tag on green. Returns whether it integrated. A conflict (→ `abortMerge`) or a red suite
 *  (→ `resetHard HEAD~1`, rolling the merge back so `stage` stays green for the NEXT item) → `{ integrated:false }`,
 *  no tag; the item re-drives from fresh `main` (the loop's existing re-drive). */
export async function mergeToStage(
  branch: string,
  stageBranch: string,
  rcTag: string,
  mainRoot: string,
  io: StageIo,
): Promise<{ integrated: boolean }> {
  // CREATE-IF-ABSENT — a fresh repo (or the first item after a release) has no staging branch yet. Cut it from
  // `main` on first use so integration always runs. (Runs in `mainRoot` — a non-destructive `git branch`.)
  if (!(await io.branchExists(stageBranch, mainRoot))) {
    await io.createBranch(stageBranch, STAGE_BASE_BRANCH, mainRoot);
  }
  // GF.4 — THE DESTRUCTIVE-CONTEXT FIX: the checkout/merge/reset run in the STAGING branch's OWN worktree, NEVER
  // the main working tree. The original bug ran `checkout stage` + `merge` + `reset --hard HEAD~1` in `mainRoot`,
  // checking the main tree away from the loop branch and resetting it = WORK-LOSS. The worktree physically
  // isolates the destructive ops to a separate directory (durability-first).
  const wt = await io.worktreeAddOrReuse(
    stageBranch,
    stageWorktreePath(mainRoot, stageBranch),
    mainRoot,
  );
  const merged = await io
    .mergeNoFf(branch, wt)
    .then(() => true)
    .catch(() => false);
  if (!merged) {
    await io.abortMerge(wt).catch(() => undefined); // conflict → no integration; the item re-drives from fresh main
    return { integrated: false };
  }
  if (!(await io.runSuite(wt))) {
    await io.resetHard('HEAD~1', wt); // red-on-merge → roll the merge back IN THE WORKTREE; stage stays green
    return { integrated: false };
  }
  await io.tagPush(rcTag, wt); // rc tag on the green integration (step 7 — no untagged state)
  return { integrated: true };
}
