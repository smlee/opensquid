/**
 * Role: reconcile the local base against origin/production without discarding commits.
 * Context: injectable git seam; production branch name from version-control.environments.
 * Constraints: origin-ahead → FF; local-ahead → keep; diverged → merge (both kept); conflict → surface.
 * Output: typed ReconcileResult (never silent loss).
 *
 * Replaces autoPullMain's --ff-only reject-on-divergence (hot-patch unsafe).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export type ReconcileResult =
  | { kind: 'ff' }
  | { kind: 'kept-local' }
  | { kind: 'merged' }
  | { kind: 'conflict'; message: string };

/** Injectable git effects — tests pass pure stubs; no real git. */
export interface BaseRefreshIo {
  fetch: (remote: string, ref: string, cwd: string) => Promise<void>;
  checkout: (ref: string, cwd: string) => Promise<void>;
  revParse: (ref: string, cwd: string) => Promise<string>;
  /** True when `maybeAncestor` is an ancestor of `rev` (or equal). */
  isAncestor: (maybeAncestor: string, rev: string, cwd: string) => Promise<boolean>;
  merge: (ref: string, cwd: string) => Promise<void>; // throws on conflict
  abortMerge: (cwd: string) => Promise<void>;
}

export const realBaseRefreshIo: BaseRefreshIo = {
  fetch: async (remote, ref, cwd) => {
    await execFileP('git', ['fetch', remote, ref], { cwd });
  },
  checkout: async (ref, cwd) => {
    await execFileP('git', ['checkout', ref], { cwd });
  },
  revParse: async (ref, cwd) => {
    const { stdout } = await execFileP('git', ['rev-parse', ref], { cwd });
    return stdout.trim();
  },
  isAncestor: async (maybeAncestor, rev, cwd) =>
    execFileP('git', ['merge-base', '--is-ancestor', maybeAncestor, rev], { cwd })
      .then(() => true)
      .catch(() => false),
  merge: async (ref, cwd) => {
    await execFileP('git', ['merge', '--no-edit', ref], { cwd });
  },
  abortMerge: async (cwd) => {
    await execFileP('git', ['merge', '--abort'], { cwd }).catch(() => undefined);
  },
};

/**
 * Role: whoever's-ahead reconcile of `base` against `${remote}/${base}`.
 * Context: cwd checkout, production (or local base) branch name, remote name.
 * Constraints: never reset/rebase away commits; conflict is fail-visible.
 * Output: ReconcileResult.
 */
export async function reconcileBase(
  cwd: string,
  base: string,
  remote = 'origin',
  io: BaseRefreshIo = realBaseRefreshIo,
): Promise<ReconcileResult> {
  await io.fetch(remote, base, cwd);
  await io.checkout(base, cwd);
  const localTip = await io.revParse('HEAD', cwd);
  const remoteTip = await io.revParse(`${remote}/${base}`, cwd);
  if (localTip === remoteTip) return { kind: 'ff' }; // already equal (no-op FF)
  const remoteIsAncestor = await io.isAncestor(remoteTip, localTip, cwd); // local ahead (or equal)
  const localIsAncestor = await io.isAncestor(localTip, remoteTip, cwd); // origin ahead (or equal)
  if (localIsAncestor && !remoteIsAncestor) {
    // origin ahead → fast-forward by merging remote (FF)
    await io.merge(`${remote}/${base}`, cwd);
    return { kind: 'ff' };
  }
  if (remoteIsAncestor && !localIsAncestor) {
    // local ahead → keep as-is (whoever is ahead is more important)
    return { kind: 'kept-local' };
  }
  // diverged → merge origin into base (preserve BOTH)
  try {
    await io.merge(`${remote}/${base}`, cwd);
    return { kind: 'merged' };
  } catch (err) {
    await io.abortMerge(cwd);
    const message = err instanceof Error ? err.message : String(err);
    return { kind: 'conflict', message };
  }
}

/**
 * Role: semantic per-item branch name for PARALLELISM only (element 8 — dormant now).
 * Context: item title (orchestrator carries item.title).
 * Constraints: slug is readable; no auto/wg-<id>. Type prefix deferred (open question).
 * Output: `feat/<slug>`.
 */
export function featBranchFromTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `feat/${slug.length > 0 ? slug : 'item'}`;
}
