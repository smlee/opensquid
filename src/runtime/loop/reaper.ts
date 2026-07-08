/**
 * WGL.4 — the GC reaper (docs/tasks/T-workgraph-lifecycle.md, §6.4 decision).
 *
 * A pure mechanism that finds ORPHANED decomposition stubs and soft-archives them (WGL.1). An orphan is an OPEN
 * issue that IS a decomposition child (a `sourceElementId:` body) but has NO incoming `parent-child` edge — i.e.
 * no live owner (the real `wg-1efc09a81fc0` stub pattern: passes every `listReady` filter yet `scopeGate` holds
 * it forever). Post-WGL.2 every legitimate child has an owner edge, so only pre-ownership / aborted-decompose
 * stubs match — exactly the accretion being drained. Archiving is SOFT (reversible, history-preserving) and
 * IDEMPOTENT (an archived stub is no longer open, so a second pass is a no-op).
 *
 * NB — the orphan definition is deliberately NARROW: a legitimately-held HUMAN task awaiting scope has NO
 * `sourceElementId:` body, so it is NEVER reaped (that marker is the load-bearing discriminator between a
 * decompose stub and a real task). The reaper only calls `archiveIssue` — it never advances/creates a checkpoint
 * or scopes an item (the automation-never-scopes invariant, loop_stage.ts).
 *
 * Imports from: ../../workgraph/types.js. Imported by: session_end_reap.ts, orchestrator.ts (the two triggers).
 */
import type { WorkGraphFacade } from '../../workgraph/types.js';

/**
 * An orphan = an OPEN issue that IS a decomposition child (`sourceElementId:` body) but has NO incoming
 * parent-child edge (no live owner). A real TASK issue (no sourceElementId body) is never an orphan; a
 * claimed/wedged/closed/archived item is never touched (only `open` matches).
 */
export function isOrphan(
  issue: { id: string; status: string; body: string },
  ownedIds: ReadonlySet<string>,
): boolean {
  return (
    issue.status === 'open' && /^sourceElementId:/m.test(issue.body) && !ownedIds.has(issue.id)
  );
}

/** Archive every orphan on the board; returns the archived ids. Idempotent (an archived stub is no longer open). */
export async function reapOrphans(wg: WorkGraphFacade): Promise<string[]> {
  const [issues, edges] = await Promise.all([wg.listIssues(), wg.listEdges()]);
  const ownedIds = new Set(edges.filter((e) => e.type === 'parent-child').map((e) => e.to));
  const orphans = issues.filter((i) => isOrphan(i, ownedIds));
  for (const o of orphans)
    await wg.archiveIssue(o.id, 'orphaned decomposition stub (no live owner) — reaped');
  return orphans.map((o) => o.id);
}
