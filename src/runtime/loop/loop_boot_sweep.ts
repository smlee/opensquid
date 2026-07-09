/**
 * F1c — the one-time boot backlog sweep (post-ship logic fixes, §3.7 element 1c).
 *
 * The feed is a PURE FOLD over the push stream: closed-ness reaches it via a PUSH at the one close boundary
 * ({@link ../../workgraph/store.ts}'s `onIssueTerminal`). But a close that landed BEFORE this fix shipped (or in a
 * crash window between the status write and the emit) left the item wg-terminal with NO close event — so it still
 * folds live and lingers on the feed forever (the observed precedent: `wg-61db3…`, `wg-141e…`, …). This sweep
 * drains that pre-existing backlog ONCE at loop start: a single bounded, set-based read of wg-terminal status
 * (`listIssues({status})` — NOT a per-item `getIssue`, and NOT on the render/emit hot path) emits a synthetic
 * `item_closed` for any item that folds live but reads wg-terminal. An already-observed close folds `terminal`
 * already ⇒ it is not in the live set ⇒ it gets no duplicate emit (the fold is idempotent regardless).
 *
 * Bounded + off the hot path: runs once per process from the orchestrator entry, fail-open (a sweep fault must
 * never break the drain). Keeps the design's pure-fold invariant — no per-render/per-emit wg pull.
 *
 * Imports from: ./loop_state.js (the live fold), ./monitor_emit.js (the fail-open push), ../../workgraph/types.js.
 * Imported by: src/runtime/ralph/orchestrator.ts (the one boot call).
 */
import type { Issue, IssueStatus } from '../../workgraph/types.js';

import { collectLoopState, liveItems } from './loop_state.js';
import { emitMonitorEvent } from './monitor_emit.js';

/** The minimal wg read surface the sweep needs — a set-based terminal-status read. */
export interface BootSweepReader {
  listIssues(filter?: { status?: IssueStatus }): Promise<Issue[]>;
}

/** The two wg-terminal statuses whose items must not linger live on the feed. */
const TERMINAL_STATUSES: IssueStatus[] = ['closed', 'archived'];

/**
 * Drain the terminal backlog once: emit a synthetic `item_closed` for every item that folds LIVE on the feed yet
 * reads wg-terminal. Returns the number of synthetic closes emitted (for narration/tests). PURE-fold preserving:
 * the emit rides the same push stream every other close uses. `now` is injectable for deterministic tests.
 */
export async function sweepTerminalBacklog(
  wg: BootSweepReader,
  now: number = Date.now(),
): Promise<number> {
  const live = liveItems(await collectLoopState());
  if (live.length === 0) return 0; // nothing folds live → nothing can linger

  // ONE bounded set-based read per terminal status (not a per-item getIssue). Robust to a reader that ignores the
  // filter: we re-check each returned issue's status is terminal before trusting it.
  const terminal = new Set<string>();
  for (const status of TERMINAL_STATUSES) {
    for (const issue of await wg.listIssues({ status })) {
      if (TERMINAL_STATUSES.includes(issue.status)) terminal.add(issue.id);
    }
  }

  let emitted = 0;
  for (const item of live) {
    if (terminal.has(item.wgId)) {
      await emitMonitorEvent({ wgId: item.wgId, kind: 'item_closed', atMs: now });
      emitted++;
    }
  }
  return emitted;
}
