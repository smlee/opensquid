/**
 * #16 — the retention-prune GATE (design: docs/reports/v2-scope-clarifications-2026-07-01.md:150).
 *
 * The 30-day retention sweep (`session-end.ts` Part 2, `backend.sweepRetired`) HARD-DELETES retired
 * agent memories. Per #16 it must NOT run unconditionally every session-end — it activates only when
 * BOTH hold for the current project:
 *
 *   1. "entire work-graph cycle complete" = the cwd project's work-graph has NO `open` AND NO
 *      `in_progress` issues (all work closed). Reuses the existing work-graph store (no new store).
 *   2. "deployed or committed" = the project's git working tree is CLEAN (`git status --porcelain`
 *      returns nothing — no uncommitted/untracked changes). A standard git-state read.
 *
 * This is a TIMING/SAFETY gate (don't prune while work is in-flight or uncommitted), NOT a per-project
 * data-scoping decision: the sweep itself stays global; we only gate WHEN it may run.
 *
 * FAIL-CLOSED on the DECISION: any error, unreadable signal, or uncertainty ⇒ `false` ⇒ do NOT prune
 * this session. Never delete when unsure. (`session-end.ts` additionally wraps the call so a gate error
 * can never break session teardown — fail-OPEN on the hook.)
 *
 * INJECTABLE (`deps`): tests pass pure readers; the default binds the shipped work-graph store +
 * `git status --porcelain`. Imports from: node:child_process, node:util, node:path,
 *   ../paths.js, ../actor_id.js, ../../workgraph/store.js.
 * Imported by: session-end.ts + session_end_prune_gate.test.ts.
 */
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { resolveActorId } from '../actor_id.js';
import { resolveLocalStoreDir } from '../paths.js';

import { workGraphStore } from '../../workgraph/store.js';

const execFileP = promisify(execFile);

/** The two signals the prune gate predicates on — injectable for deterministic unit tests. */
export interface PruneGateDeps {
  /** Number of `open`+`in_progress` issues in the cwd project's work-graph (0 ⇒ cycle complete). */
  openWorkCount(cwd: string): Promise<number>;
  /** `true` iff the git working tree at `cwd` is CLEAN (no uncommitted/untracked changes). */
  gitClean(cwd: string): Promise<boolean>;
}

/** Default readers: the shipped work-graph store + a standard `git status --porcelain` clean check. */
export const defaultPruneGateDeps: PruneGateDeps = {
  async openWorkCount(cwd) {
    // T-project-local-state PLS.2: count THIS project's LOCAL work-graph (`<root>/.opensquid/workgraph.db`,
    // resolved from cwd). No close(): the libSQL client is reclaimed by the hook's process.exit.
    const dir = await resolveLocalStoreDir(cwd);
    const store = workGraphStore({
      dbUrl: `file:${join(dir, 'workgraph.db')}`,
      sourceDir: join(dir, 'store', 'issues'),
      actorId: await resolveActorId(),
    });
    await store.init();
    const open = await store.listIssues({ status: 'open' });
    const inProgress = await store.listIssues({ status: 'in_progress' });
    return open.length + inProgress.length;
  },
  async gitClean(cwd) {
    // Not a git repo / any git error ⇒ execFileP rejects ⇒ the caller's catch ⇒ fail-closed (no prune).
    const { stdout } = await execFileP('git', ['status', '--porcelain'], { cwd });
    return stdout.trim() === '';
  },
};

/**
 * The #16 gate: `true` iff the cwd project's work-graph cycle is complete AND the tree is committed/clean.
 * FAIL-CLOSED — any error or unevaluable signal returns `false` (skip the prune this session; never
 * delete when unsure). Short-circuits: an incomplete cycle skips the git read entirely.
 */
export async function retentionPruneAllowed(
  cwd: string,
  deps: PruneGateDeps = defaultPruneGateDeps,
): Promise<boolean> {
  try {
    if ((await deps.openWorkCount(cwd)) !== 0) return false; // cycle not complete
    return (await deps.gitClean(cwd)) === true; // deployed/committed
  } catch {
    return false; // fail-closed on any uncertainty — do NOT prune
  }
}
