// src/runtime/ralph/worktree_pool.ts — DORMANT bounded-concurrency/worktree primitives. Serial runRalphLoop does
// not call this module. Future parallelism must explicitly supply each unique semantic branch, configured base,
// and drive cwd before wiring these helpers. Every git effect stays behind WorktreeIo, so tests need no real git
// or `.opensquid` I/O. Historical AGF.3 mechanics are retained without mechanical WorkGraph-id Git refs.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const execFileP = promisify(execFile);

/** The injectable git effects — default binds real `git worktree add/remove`; tests pass a pure stub. */
export interface WorktreeIo {
  /** `git worktree add -b <branch> <path> <base>` run in `mainRoot` — cut `branch` from `base` in its own checkout. */
  worktreeAdd: (branch: string, path: string, base: string, mainRoot: string) => Promise<void>;
  /** `git worktree remove --force <path>` run in `mainRoot` — teardown. */
  worktreeRemove: (path: string, mainRoot: string) => Promise<void>;
}

/** The pool config: a fixed concurrency `bound`, the configured production `baseBranch`, and the internal checkout
 *  roots. Adaptive scaling remains later scope; WorkGraph ids name only `<poolRoot>/<id>` paths. */
export interface PoolConfig {
  bound: number;
  baseBranch: string;
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

/** DORMANT parallel primitive: add an item checkout on the caller-selected semantic branch and configured
 *  production base, at `<poolRoot>/<id>`. WorkGraph ids remain internal path context and never become Git refs.
 *  Branch allocation/collision policy belongs to the future parallel coordinator; this utility does not guess it.
 *  Returns the checkout path — the cwd a future parallel drive must explicitly receive. */
export async function addItemWorktree(
  id: string,
  branch: string,
  baseBranch: string,
  mainRoot: string,
  poolRoot: string,
  io: WorktreeIo,
): Promise<string> {
  const path = join(poolRoot, id);
  await io.worktreeAdd(branch, path, baseBranch, mainRoot);
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
  claimNext: () => Promise<{ id: string; branch: string } | null>,
  driveInWorktree: (item: { id: string; branch: string }, worktreePath: string) => Promise<O>,
  io: WorktreeIo,
): Promise<O[]> {
  const out: O[] = [];
  const inFlight = new Set<Promise<void>>();
  const startOne = async (item: { id: string; branch: string }): Promise<void> => {
    let path: string | undefined;
    try {
      path = await addItemWorktree(
        item.id,
        item.branch,
        cfg.baseBranch,
        cfg.mainRoot,
        cfg.poolRoot,
        io,
      );
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
