// src/runtime/ralph/worktree_pool.ts — bounded concurrency pool + worktree-per-item. Attaches to runRalphLoop
// (orchestrator.ts:262-357): the serial claim-one/drive-one becomes a bounded-N claim-and-drive, each item in its
// OWN git worktree cut from fresh `main` (AGF.2) so concurrent laps never clobber each other's edits. Every git
// effect is behind the injectable WorktreeIo seam (default = real `execFileP('git', …)`), so tests drive the pool
// with NO real git and NO `.opensquid` I/O.
//
// AGF.3 (T-opensquid-automated-gitflow, wg-4ae1004c931b). Consumed by AGF.7's pool + orchestrator-integration tests.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

import { branchNameFor } from './auto_pull.js';

const execFileP = promisify(execFile);

/** The injectable git effects — default binds real `git worktree add/remove`; tests pass a pure stub. */
export interface WorktreeIo {
  /** `git worktree add -b <branch> <path> <base>` run in `mainRoot` — cut `branch` from `base` in its own checkout. */
  worktreeAdd: (branch: string, path: string, base: string, mainRoot: string) => Promise<void>;
  /** `git worktree remove --force <path>` run in `mainRoot` — teardown. */
  worktreeRemove: (path: string, mainRoot: string) => Promise<void>;
}

/** The pool config: the concurrency `bound` (a FIXED default — adaptive scaling is a later scope, design §5 OUT)
 *  and the `poolRoot` under which each item's worktree checkout lives (`<poolRoot>/<id>`). */
export interface PoolConfig {
  bound: number;
  poolRoot: string;
  mainRoot: string;
}

/** The default real WorktreeIo — cut/teardown each worktree via git in `mainRoot` (never in the item's checkout).
 *  Teardown is `--force` so a stale worktree from a crashed lap does not wedge the next pass. */
export const realWorktreeIo: WorktreeIo = {
  worktreeAdd: async (branch, path, base, mainRoot) => {
    await execFileP('git', ['worktree', 'add', '-b', branch, path, base], { cwd: mainRoot });
  },
  worktreeRemove: async (path, mainRoot) => {
    await execFileP('git', ['worktree', 'remove', '--force', path], { cwd: mainRoot });
  },
};

/** Add the item's worktree on `auto/wg-<id>` (AGF.2's `branchNameFor`) cut from `main` (AGF.2's fresh base), at
 *  `<poolRoot>/<id>`. Returns the checkout path — the cwd the item's drive runs in. */
export async function addItemWorktree(
  id: string,
  mainRoot: string,
  poolRoot: string,
  io: WorktreeIo,
): Promise<string> {
  const path = join(poolRoot, id);
  await io.worktreeAdd(branchNameFor(id), path, 'main', mainRoot);
  return path;
}

/** `git worktree remove --force <path>` — teardown the item's checkout once its drive finishes. */
export async function removeItemWorktree(
  path: string,
  mainRoot: string,
  io: WorktreeIo,
): Promise<void> {
  await io.worktreeRemove(path, mainRoot);
}

/** Drive up to `bound` claimed items CONCURRENTLY, each in its own worktree; fold outcomes into the returned array.
 *  A driven-item FAULT is ISOLATED — its worktree is torn down (a `finally`) and the drain continues (it never
 *  breaks the other in-flight items), mirroring the orchestrator's fail-open fold. `claimNext` MUST stay the atomic
 *  `claimIssue` CAS so two slots never claim the same item. The serial path is the `bound:1` degenerate case. */
export async function drainPool<O>(
  cfg: PoolConfig,
  claimNext: () => Promise<{ id: string } | null>,
  driveInWorktree: (item: { id: string }, worktreePath: string) => Promise<O>,
  io: WorktreeIo,
): Promise<O[]> {
  const out: O[] = [];
  const inFlight = new Set<Promise<void>>();
  const startOne = async (item: { id: string }): Promise<void> => {
    let path: string | undefined;
    try {
      path = await addItemWorktree(item.id, cfg.mainRoot, cfg.poolRoot, io);
      out.push(await driveInWorktree(item, path));
    } finally {
      if (path !== undefined)
        await removeItemWorktree(path, cfg.mainRoot, io).catch(() => undefined);
    }
  };
  for (;;) {
    while (inFlight.size < cfg.bound) {
      const item = await claimNext();
      if (item === null) break; // no more eligible items to claim this pass
      const p = startOne(item)
        .catch(() => undefined) // a driven-item fault is isolated — never breaks the drain
        .finally(() => inFlight.delete(p));
      inFlight.add(p);
    }
    if (inFlight.size === 0) break; // drained: nothing in flight and nothing left to claim
    await Promise.race(inFlight); // free a slot, then re-fill
  }
  return out;
}
