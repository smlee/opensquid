/**
 * WGL.5 — parent roll-up (docs/tasks/T-workgraph-lifecycle.md, §6.3 decision).
 *
 * After the loop closes a driven item (orchestrator.ts, the sole close site), walk the `parent-child` edges to
 * the decompose-root and auto-close any ancestor parent whose children are ALL non-drivable — every child
 * `closed` OR `archived` OR wedged-escalated (`wedgeReason` set). Recurses upward (a parent may itself be a
 * child). A wedged child does NOT hold the parent open (the loop can't drive it) but STAYS independently
 * escalated: the roll-up READS `wedgeReason` but NEVER writes/clears it and never touches the park/escalate list
 * — so a wedge is never buried by the parent close (§6.3). Pure over an injected `WorkGraphFacade`.
 *
 * Imports from: ../../workgraph/types.js. Imported by: orchestrator.ts (wired at the SHIPPED close branch).
 */
import type { Issue, WorkGraphFacade } from '../../workgraph/types.js';

/** Drivable = the loop can still act on it: `open` AND not wedged. closed / archived / wedged → non-drivable. */
const isDrivable = (i: Issue): boolean => i.status === 'open' && i.wedgeReason === undefined;

/** After a child closes, close every ancestor parent whose children are ALL non-drivable. Returns closed ids. */
export async function rollUpParents(wg: WorkGraphFacade, closedChildId: string): Promise<string[]> {
  const [issues, edges] = await Promise.all([wg.listIssues(), wg.listEdges()]);
  const byId = new Map(issues.map((i) => [i.id, i]));
  const childrenOf = (pid: string): Issue[] =>
    edges
      .filter((e) => e.type === 'parent-child' && e.from === pid)
      .map((e) => byId.get(e.to))
      .filter((i): i is Issue => i !== undefined);
  const parentsOf = (cid: string): string[] =>
    edges.filter((e) => e.type === 'parent-child' && e.to === cid).map((e) => e.from);
  const closed: string[] = [];
  const walk = async (childId: string): Promise<void> => {
    for (const pid of parentsOf(childId)) {
      const parent = byId.get(pid);
      // short-circuit an already-terminal parent so a diamond (shared grandparent) never double-closes.
      if (parent === undefined || parent.status === 'closed' || parent.status === 'archived')
        continue;
      const kids = childrenOf(pid);
      // childless guard: a leaf "parent" is closed by its own SHIPPED, not by roll-up (`every` over [] is
      // vacuously true — without this guard every childless issue would wrongly roll up).
      if (kids.length > 0 && kids.every((k) => !isDrivable(k))) {
        await wg.updateIssue(pid, { status: 'closed' }); // all children terminal → roll the parent up
        parent.status = 'closed'; // reflect in the local snapshot so the diamond short-circuit holds this walk
        closed.push(pid);
        await walk(pid); // the parent may itself be a child of a grand-parent (upward recursion; DAG → terminates)
      }
    }
  };
  await walk(closedChildId);
  return closed;
}
