/**
 * CG.1 — the CONSISTENCY GATE: an item closes SHIPPED only if a durable, item-owned commit for its work
 * exists on the integration target. The orchestrator's SHIPPED-close (`orchestrator.ts`) fired purely on the
 * FSM OUTCOME, never on "a commit exists": the pack MAKES the commit (`deploy.md:47-57`) but when that commit
 * did not land, the item was closed ANYWAY (observed defect: the reporting rebuild `wg-123340ac7a9f` read
 * `status:"closed"` while `report_display.ts`/`scope_report.ts` + 17 more files sat UNCOMMITTED). This module
 * supplies the pull-at-the-close-boundary check that makes `SHIPPED ⟺ durable commit` STRUCTURAL: closing is
 * what TRIGGERS the check.
 *
 * Every git effect is behind ONE injected seam (`RalphGitSeam`, the `StageIo`/`realStageIo` DI convention —
 * `release/stage_integration.ts:19-60`) with a real default binding (`makeRalphGitSeam`), so the predicate is
 * unit-testable with no real git and no `.opensquid` I/O, and an absent `deps.git` ⇒ the gate is a no-op
 * (backward-compatible).
 *
 * SERIAL-vs-PARALLEL boundary (surfaced, not hidden): in the current SERIAL model `uncommittedPaths()` reads
 * the ONE shared working tree, so the realizable guarantee is "a durable commit for THIS DRIVE landed with real
 * file content, and the committed portion is clean." The one residue the shared serial tree cannot perfectly
 * close without an item-file manifest — an item that committed NOTHING while a wholly-unrelated drive-by COMMIT
 * moved the tip — is closed EXACTLY by the per-item commit identity in the future parallel model (each item
 * drives on its own worktree/branch `auto/wg-<id>`, where `uncommittedPaths()`/`committedSince()` are scoped to
 * the item's worktree and there is no cross-item drive-by). The predicate is IDENTICAL in both models — only
 * the seam's binding (shared HEAD vs the item worktree) changes. The observed defect (tip UNMOVED, files dirty)
 * is caught by the `advanced` clause in BOTH models today.
 *
 * Imported by: src/runtime/ralph/orchestrator.ts (the SHIPPED-close boundary).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/** The bounded item-level commit re-drive count before parking `no-durable-commit` (open-Q2). Distinct from
 *  MAX_STAGE_RETRIES (the intra-item no-advance stage bound, `orchestrator.ts:153`). Two extra attempts =
 *  one clean retry + a margin, then the item parks so the human sees the stranded-uncommitted work. */
export const MAX_COMMIT_REDRIVES = 2;

/** The surfaced park-reason string (never a silent close). */
export const NO_DURABLE_COMMIT_LABEL = 'no-durable-commit';

/** Injectable commit-existence reads the consistency gate needs — the default binds real `git` (the `StageIo`
 *  convention, `stage_integration.ts:19-60`). An omitted `deps.git` ⇒ no gate (backward-compatible). Serial:
 *  reads the shared working tree / loop-branch HEAD; parallel (future): the seam is bound to the item's
 *  worktree/branch — SAME predicate, only the binding changes. */
export interface RalphGitSeam {
  /** The integration target's current tip sha (`git rev-parse <ref ?? HEAD>`). GF.2: an optional `ref` resolves
   *  the CONFIGURED integration-target branch; ABSENT ⇒ HEAD (byte-identical to the shipped base gate). */
  tip: (ref?: string) => Promise<string>;
  /** File paths COMMITTED on the target since baseSha (`git diff --name-only <baseSha>..<ref ?? HEAD>`); [] ⇒ none. */
  committedSince: (baseSha: string, ref?: string) => Promise<string[]>;
  /** The working-tree dirty set — staged + unstaged + untracked (`git status --porcelain` paths). */
  uncommittedPaths: () => Promise<string[]>;
}

/** The default real binding — thin `git` pass-throughs bound to `cwd` (mirrors `realStageIo`, stage_integration.ts:32-60).
 *  A factory (binds the loop repo root once) rather than a per-call-`cwd` object, so the orchestrator's gate call
 *  carries no cwd plumbing. */
export function makeRalphGitSeam(cwd: string): RalphGitSeam {
  return {
    tip: async (ref) =>
      (await execFileP('git', ['rev-parse', ref ?? 'HEAD'], { cwd })).stdout.trim(),
    committedSince: async (baseSha, ref) =>
      (
        await execFileP('git', ['diff', '--name-only', `${baseSha}..${ref ?? 'HEAD'}`], { cwd })
      ).stdout
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0),
    uncommittedPaths: async () =>
      (await execFileP('git', ['status', '--porcelain'], { cwd })).stdout
        .split('\n')
        .map((l) => l.slice(3).trim()) // porcelain: 2 status cols + a space, then the path
        .filter((l) => l.length > 0),
  };
}

/** open-Q1 — a durable, item-owned commit exists on the target: the tip ADVANCED past `baseSha` with real
 *  committed file content, AND none of the item's committed files is left dirty/staged. Unrelated drive-by dirt
 *  (a dirty path the item never committed) is tolerated by construction — it is not in `committed`, so it never
 *  enters the intersection (honors the drive-by-files rule: surface unrelated dirt, don't fold it in). PURE — no
 *  side effects; every read is through the injected seam. */
export async function durableItemCommitExists(
  git: RalphGitSeam,
  baseSha: string,
  targetRef?: string,
): Promise<boolean> {
  // GF.2 (open-Q2) — resolve the tip/committed-set on the CONFIGURED integration target when `targetRef` is given
  // (staging ?? local); ABSENT ⇒ HEAD, byte-identical to the shipped 6436a220 predicate (backward-compatible).
  const tip = await git.tip(targetRef);
  const committed = await git.committedSince(baseSha, targetRef);
  const advanced = tip !== baseSha && committed.length > 0; // tip moved AND ≥1 file committed (not an empty commit)
  if (!advanced) return false; // headline: reporting item — tip unmoved / nothing committed
  const dirty = new Set(await git.uncommittedPaths());
  return committed.every((p) => !dirty.has(p)); // item's committed work is clean (partial-commit guard)
}
