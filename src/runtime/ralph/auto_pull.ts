// src/runtime/ralph/auto_pull.ts — step-0 "never a stale base" mechanic + the `auto/wg-<id>` branch-name SSOT.
// Generic git only; the pool (AGF.3) owns WHEN to pull + branch. Mirrors the execFileP('git', …, { cwd }) idiom
// (release_core.ts:12,21-30).
//
// AGF.2 (T-opensquid-automated-gitflow, wg-f2f8e8609ee6). Consumed by AGF.3's worktree cut + AGF.4's branch push.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/** The `auto/wg-<id>` branch convention — the SINGLE source AGF.3's `git worktree add -b`, AGF.4's `git push`,
 *  and AGF.5's `mergeToStage(branch)` all reference. The id already carries the `wg-` prefix, so
 *  `branchNameFor('wg-abc123')` → `'auto/wg-abc123'` (never double-prefixed). */
export const branchNameFor = (id: string): string => `auto/${id}`;

/** Fetch + fast-forward the local `main` to `<remote>/main` so the branch base is never stale (step 0). FF-only:
 *  a clean automation checkout is never diverged from origin/main; a divergence is a real fault (the `--ff-only`
 *  merge REJECTS → the promise rejects and the caller surfaces it), never a silent merge commit on `main`. Leaves
 *  the working tree ON `main`; the pool (AGF.3) then cuts each worktree from that fresh base. Fetch is scoped to
 *  `main` (not `--all`) to stay fast — the `auto/wg-*` branches are pushed by AGF.4, not fetched here. */
export async function autoPullMain(cwd: string, remote = 'origin'): Promise<void> {
  await execFileP('git', ['fetch', remote, 'main'], { cwd });
  await execFileP('git', ['checkout', 'main'], { cwd });
  await execFileP('git', ['merge', '--ff-only', `${remote}/main`], { cwd });
}
