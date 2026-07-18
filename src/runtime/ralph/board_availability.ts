import type { Issue, WorkGraphFacade } from '../../workgraph/types.js';

export type BoardWaitReason =
  | 'admission'
  | 'wedged'
  | 'claimed'
  | 'blocked'
  | 'in_progress'
  | 'unavailable';

export interface BoardWaitingItem {
  id: string;
  reason: BoardWaitReason;
  detail?: string;
}

export type BoardAvailability =
  | { kind: 'empty'; waiting: [] }
  | { kind: 'waiting'; waiting: BoardWaitingItem[] };

const isTerminal = (issue: Issue): boolean =>
  issue.status === 'closed' || issue.status === 'archived';

const hasLiveClaim = (issue: Issue, nowIso: string): boolean =>
  issue.claimToken !== undefined &&
  (issue.claimExpiresAt === undefined || issue.claimExpiresAt > nowIso);

/**
 * Derive the terminal board state from the WorkGraph projections. `listReady()` is intentionally insufficient:
 * it excludes blocked, wedged, claimed, and in-progress work. This one end-of-run read keeps WorkGraph as the
 * sole source of truth while reserving `BOARD_EMPTY` for a board with zero nonterminal issues.
 */
export async function inspectBoardAvailability(
  wg: WorkGraphFacade,
  admissionHeldIds: ReadonlySet<string>,
  nowIso = new Date().toISOString(),
): Promise<BoardAvailability> {
  const [issues, edges] = await Promise.all([wg.listIssues(), wg.listEdges()]);
  const live = issues.filter((issue) => !isTerminal(issue));
  if (live.length === 0) return { kind: 'empty', waiting: [] };

  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  const blockers = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.type !== 'blocks') continue;
    const blocker = byId.get(edge.from);
    if (blocker === undefined || isTerminal(blocker)) continue;
    const ids = blockers.get(edge.to) ?? [];
    ids.push(edge.from);
    blockers.set(edge.to, ids);
  }

  const waiting = live.map((issue): BoardWaitingItem => {
    if (issue.status === 'in_progress') return { id: issue.id, reason: 'in_progress' };
    if (issue.wedgeReason !== undefined)
      return { id: issue.id, reason: 'wedged', detail: issue.wedgeReason };
    if (hasLiveClaim(issue, nowIso))
      return {
        id: issue.id,
        reason: 'claimed',
        ...(issue.claimExpiresAt === undefined ? {} : { detail: issue.claimExpiresAt }),
      };
    if (admissionHeldIds.has(issue.id)) return { id: issue.id, reason: 'admission' };
    const blockedBy = blockers.get(issue.id);
    if (blockedBy !== undefined)
      return { id: issue.id, reason: 'blocked', detail: blockedBy.sort().join(',') };
    return { id: issue.id, reason: 'unavailable' };
  });
  return { kind: 'waiting', waiting };
}

export function summarizeBoardWaiting(waiting: readonly BoardWaitingItem[]): string {
  const counts = new Map<BoardWaitReason, number>();
  for (const item of waiting) counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([reason, count]) => `${reason} ${String(count)}`)
    .join(', ');
}
