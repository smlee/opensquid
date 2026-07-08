// src/runtime/release/stage_integration.ts — merge `auto/wg-<id>` → the persistent `stage` branch, re-run the
// suite on the merge, `rc`-tag ONLY on green. A conflict or a red suite → NO integration (roll back); the item
// re-drives from fresh `main`. SINGLE-WRITER on the one `stage` branch — items DROVE concurrently in worktrees
// (AGF.3) but integrate SERIALLY into `stage`, so the `rc` counter never races. Mirrors release_core.ts:17-42.
//
// AGF.5 (T-opensquid-automated-gitflow, wg-72134554548f). Consumed by AGF.6 (opens the PR from `stage`) + the
// orchestrator's onShipped wiring (the LIVE integration).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/** The persistent integration branch — long-lived, accumulating item merges between releases (design §6). */
export const STAGE_BRANCH = 'stage';

/** Injectable git + suite effects — default binds real `execFileP('git', …)` + the full pre-push suite. */
export interface StageIo {
  checkout: (ref: string, cwd: string) => Promise<void>;
  mergeNoFf: (branch: string, cwd: string) => Promise<void>; // `git merge --no-ff <branch>` (throws on conflict)
  abortMerge: (cwd: string) => Promise<void>; // `git merge --abort`
  resetHard: (ref: string, cwd: string) => Promise<void>; // `git reset --hard <ref>`
  runSuite: (cwd: string) => Promise<boolean>; // the full verifySuite; green === true (release.ts:52-56)
  tagPush: (tag: string, cwd: string) => Promise<void>; // `git tag <tag>` + push (tagAndPushTag shape)
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
  runSuite: async (cwd) =>
    execFileP('bash', ['scripts/pre-push.sh'], { cwd })
      .then(() => true)
      .catch(() => false),
  tagPush: async (tag, cwd) => {
    await execFileP('git', ['tag', tag], { cwd });
    await execFileP('git', ['push', 'origin', tag], { cwd });
  },
};

/** Merge `branch` into the persistent `stage` branch (`--no-ff`, a real integration commit), gate on the suite,
 *  and `rc`-tag on green. Returns whether it integrated. A conflict (→ `abortMerge`) or a red suite
 *  (→ `resetHard HEAD~1`, rolling the merge back so `stage` stays green for the NEXT item) → `{ integrated:false }`,
 *  no tag; the item re-drives from fresh `main` (the loop's existing re-drive). */
export async function mergeToStage(
  branch: string,
  rcTag: string,
  cwd: string,
  io: StageIo,
): Promise<{ integrated: boolean }> {
  await io.checkout(STAGE_BRANCH, cwd);
  const merged = await io
    .mergeNoFf(branch, cwd)
    .then(() => true)
    .catch(() => false);
  if (!merged) {
    await io.abortMerge(cwd).catch(() => undefined); // conflict → no integration; the item re-drives from fresh main
    return { integrated: false };
  }
  if (!(await io.runSuite(cwd))) {
    await io.resetHard('HEAD~1', cwd); // red-on-merge → roll the merge back; stage stays green
    return { integrated: false };
  }
  await io.tagPush(rcTag, cwd); // rc tag on the green integration (step 7 — no untagged state)
  return { integrated: true };
}
