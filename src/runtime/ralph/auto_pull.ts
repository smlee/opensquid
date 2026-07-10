// src/runtime/ralph/auto_pull.ts — the base-refresh reconcile + the SEMANTIC branch naming.
//
// GF.5/GF.6 (T-gitflow-integration-fix) SUPERSEDES AGF.2's `branchNameFor(auto/wg-<id>)` + `autoPullMain(--ff-only)`:
//   • The mechanical `auto/wg-<id>` name is RETIRED — the environment branches (production/staging/local, user-named
//     via `version-control.environments`, GF.1) ARE the semantic named branches. In the SERIAL model items commit to
//     `env.local` (no per-item branch); per-item semantic branches (`feat/<slug>`) return ONLY under parallelism (GF.9),
//     defined here (`featBranchFor`/`slugify`) but produced only by the dormant parallel path.
//   • The `--ff-only` reject-on-divergence is REPLACED by `reconcileBase` — a four-state reconcile that PRESERVES
//     whoever is ahead (a trunk hot patch is never lost) and SURFACES a genuine conflict to a human (never auto-picks).
//
// Generic git only, behind the injected `ReconcileIo` seam (the `StageIo`/`RalphGitSeam` DI convention). Mirrors the
// `execFileP('git', …, { cwd })` idiom (release_core.ts:12,21-30).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/** GF.5 — a URL/branch-safe slug of a title: lowercase, non-alphanumeric → `-`, trimmed, ≤60 chars. Pure. */
export const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

/** GF.5 — the parallel per-item SEMANTIC branch name (`feat/<slug-of-item.title>`). DEFINED here but produced ONLY
 *  under parallelism (GF.9); the serial path commits to `env.local`. The `<type>` prefix source is DEFERRED
 *  (open-Q1, pinned when parallelism lands) — only `feat/` is used, from the grounded `item.title` source. */
export const featBranchFor = (title: string): string => `feat/${slugify(title)}`;

/** GF.6 — the reconcile outcome. `conflict` → the loop SURFACES to a human (never auto-picks a side). */
export type ReconcileOutcome =
  | { kind: 'up-to-date' }
  | { kind: 'fast-forwarded' }
  | { kind: 'kept-local' }
  | { kind: 'merged' }
  | { kind: 'conflict' };

/** GF.6 — the injected git effects the base-refresh reconcile needs (the `StageIo` seam convention). Deliberately
 *  has NO reset/rebase method — preserve-whoever's-ahead means a discard/rewrite of pushed history is
 *  UNREPRESENTABLE (open-Q4: MERGE, never rebase/reset). Default binds real `git` (`realReconcileIo`). */
export interface ReconcileIo {
  fetch: (remote: string, branch: string, cwd: string) => Promise<void>;
  checkout: (ref: string, cwd: string) => Promise<void>;
  /** `git rev-list --left-right --count <base>...<remoteRef>` → {behind, ahead} relative to the LOCAL base. */
  counts: (
    base: string,
    remoteRef: string,
    cwd: string,
  ) => Promise<{ behind: number; ahead: number }>;
  ffMerge: (remoteRef: string, cwd: string) => Promise<void>; // `git merge --ff-only`
  mergeNoEdit: (remoteRef: string, cwd: string) => Promise<boolean>; // `git merge --no-edit` → false on conflict
  abortMerge: (cwd: string) => Promise<void>;
}

/** The default real ReconcileIo — thin `git` pass-throughs bound to the caller's cwd. */
export const realReconcileIo: ReconcileIo = {
  fetch: async (remote, branch, cwd) => {
    await execFileP('git', ['fetch', remote, branch], { cwd });
  },
  checkout: async (ref, cwd) => {
    await execFileP('git', ['checkout', ref], { cwd });
  },
  counts: async (base, remoteRef, cwd) => {
    // `--left-right --count A...B` prints "<left>\t<right>": left = commits in A not B (LOCAL ahead of remote →
    // "behind remote" = right), so column order is `behind<TAB>ahead` when A=base and B=remoteRef? No — with
    // `base...remoteRef`, left = base-only (LOCAL commits not on remote = ahead), right = remoteRef-only (commits
    // the local base is behind). We flip to report {behind: right, ahead: left}.
    const { stdout } = await execFileP(
      'git',
      ['rev-list', '--left-right', '--count', `${base}...${remoteRef}`],
      { cwd },
    );
    const [ahead = 0, behind = 0] = stdout
      .trim()
      .split(/\s+/)
      .map((n) => Number(n) || 0);
    return { behind, ahead };
  },
  ffMerge: async (remoteRef, cwd) => {
    await execFileP('git', ['merge', '--ff-only', remoteRef], { cwd });
  },
  mergeNoEdit: async (remoteRef, cwd) =>
    execFileP('git', ['merge', '--no-edit', remoteRef], { cwd })
      .then(() => true)
      .catch(() => false),
  abortMerge: async (cwd) => {
    await execFileP('git', ['merge', '--abort'], { cwd });
  },
};

/** GF.6 (open-Q4: MERGE, never rebase/reset) — reconcile the local base branch (`production`) with origin,
 *  PRESERVING whoever is ahead. A total four-state FSM over `(behind, ahead)`:
 *    (0,0)            → up-to-date (no-op)
 *    (behind>0, 0)    → origin-ahead   → fast-forward
 *    (0, ahead>0)     → local-ahead    → keep (the local hot patch stays)
 *    (behind>0, ahead>0) → diverged    → MERGE origin into the base (preserve BOTH)
 *  A merge CONFLICT → abort + `{ kind: 'conflict' }` the loop surfaces to a human. A hot patch straight to
 *  production is thus pulled into the base and can never be reverted by a later PR (durability-first). The base
 *  branch NAME is `production` (config, GF.1) — never a hardcoded `main`. */
export async function reconcileBase(
  cwd: string,
  production: string,
  remote = 'origin',
  io: ReconcileIo = realReconcileIo,
): Promise<ReconcileOutcome> {
  await io.fetch(remote, production, cwd);
  await io.checkout(production, cwd);
  const { behind, ahead } = await io.counts(production, `${remote}/${production}`, cwd);
  if (behind === 0 && ahead === 0) return { kind: 'up-to-date' };
  if (behind > 0 && ahead === 0) {
    await io.ffMerge(`${remote}/${production}`, cwd);
    return { kind: 'fast-forwarded' };
  }
  if (ahead > 0 && behind === 0) return { kind: 'kept-local' }; // local hot patch stays
  const merged = await io.mergeNoEdit(`${remote}/${production}`, cwd); // diverged → MERGE (preserve both)
  if (!merged) {
    await io.abortMerge(cwd).catch(() => undefined);
    return { kind: 'conflict' };
  }
  return { kind: 'merged' };
}
