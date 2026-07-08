/**
 * report_checklist — "THE WORKGRAPH IS THE CHECKLIST."
 *
 * Design-of-record: loop/docs/design/opensquid-reporting-model.md §4.2 + §7.1.
 *
 * The board-is-the-checklist model
 * --------------------------------
 * A before-stage report does not carry its own free-text checklist. Instead it
 * decomposes the stage's scope into parent-child workgraph sub-issues — one
 * tracked item per committed piece of work. The report is "resolved" exactly
 * when those committed sub-issues are CLOSED on the board. There is no second
 * source of truth: the workgraph itself IS the checklist, and closing an issue
 * IS ticking the box.
 *
 * This module is the pure classifier over that committed set. Given the current
 * status of each committed sub-issue, it assigns one of three states and rolls
 * them up into a resolution verdict the automation gate can act on.
 *
 * The three states
 * ----------------
 *  - 'done'       — the sub-issue is CLOSED. The box is ticked; work landed.
 *
 *  - 'deferred'   — the sub-issue is still open/in_progress BUT carries a
 *                   non-empty `wedgeReason`. This is an EXPLICITLY-deferred,
 *                   "✗-with-reason" tracked follow-up: the work didn't land, but
 *                   it was named and its blocker recorded on the board. A
 *                   deferred item is honest and does NOT block — it is a
 *                   deliberate, visible carry-forward. Its `wedgeReason` is
 *                   surfaced back as the item's `reason`.
 *
 *  - 'unresolved' — the sub-issue is still open/in_progress WITHOUT any
 *                   `wedgeReason` (missing or empty/whitespace). This is the
 *                   silently-unresolved case — a committed box that was never
 *                   ticked and never explained. This is precisely the drift the
 *                   reporting model exists to catch, so under automation an
 *                   unresolved item BLOCKS the stage.
 *
 * Rollup
 * ------
 * `unresolved` collects every item in the 'unresolved' state, and
 * `allResolved` is true iff there are none. An EMPTY committed set trivially
 * resolves (`allResolved === true`): nothing was committed, so nothing can be
 * silently dropped.
 *
 * Purity: this module performs no I/O and reads no clock — it is a total
 * function of its input, safe to call anywhere in the gate pipeline.
 */

export type ChecklistItemState = 'done' | 'deferred' | 'unresolved';

/** A committed sub-issue as it currently stands on the workgraph board. */
export interface ChecklistSubIssue {
  id: string;
  title: string;
  // WGL.1 — 'archived' is a terminal state (a soft-archived/superseded child): it counts as DONE (resolved),
  // never silently-unresolved.
  status: 'open' | 'in_progress' | 'closed' | 'archived';
  /** Present only when the item was explicitly deferred with a recorded blocker. */
  wedgeReason?: string;
}

/** A classified checklist line. `reason` is set ONLY on 'deferred' items. */
export interface ChecklistItem {
  id: string;
  title: string;
  state: ChecklistItemState;
  reason?: string;
}

/** The board-derived resolution verdict for a before-stage report. */
export interface ChecklistResolution {
  items: ChecklistItem[];
  unresolved: ChecklistItem[];
  allResolved: boolean;
}

function hasWedgeReason(
  sub: ChecklistSubIssue,
): sub is ChecklistSubIssue & { wedgeReason: string } {
  return typeof sub.wedgeReason === 'string' && sub.wedgeReason.trim().length > 0;
}

function classify(sub: ChecklistSubIssue): ChecklistItem {
  if (sub.status === 'closed' || sub.status === 'archived') {
    return { id: sub.id, title: sub.title, state: 'done' }; // WGL.1 — archived is terminal (resolved)
  }
  // status is 'open' or 'in_progress' here.
  if (hasWedgeReason(sub)) {
    const state: ChecklistItemState = 'deferred';
    const reason = sub.wedgeReason;
    return { id: sub.id, title: sub.title, state, ...(state === 'deferred' ? { reason } : {}) };
  }
  return { id: sub.id, title: sub.title, state: 'unresolved' };
}

/**
 * Resolve the committed sub-issues into a checklist verdict.
 *
 * See the file-level doc comment for the board-is-the-checklist model and the
 * meaning of each state. An empty input array resolves trivially.
 */
export function resolveChecklist(subIssues: ChecklistSubIssue[]): ChecklistResolution {
  const items = subIssues.map(classify);
  const unresolved = items.filter((item) => item.state === 'unresolved');
  return { items, unresolved, allResolved: unresolved.length === 0 };
}
