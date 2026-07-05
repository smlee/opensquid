import { describe, expect, it } from 'vitest';

import { resolveChecklist } from './report_checklist.js';
import type { ChecklistSubIssue } from './report_checklist.js';

describe('resolveChecklist — the workgraph is the checklist', () => {
  it('classifies a CLOSED sub-issue as done (no reason set)', () => {
    const subs: ChecklistSubIssue[] = [{ id: 'a', title: 'ship auth', status: 'closed' }];
    const res = resolveChecklist(subs);

    expect(res.items).toEqual([{ id: 'a', title: 'ship auth', state: 'done' }]);
    expect(res.items[0]).not.toHaveProperty('reason');
    expect(res.unresolved).toEqual([]);
    expect(res.allResolved).toBe(true);
  });

  it('closed items ignore any wedgeReason and stay done without a reason', () => {
    const subs: ChecklistSubIssue[] = [
      { id: 'a', title: 'done thing', status: 'closed', wedgeReason: 'leftover note' },
    ];
    const res = resolveChecklist(subs);

    expect(res.items[0]?.state).toBe('done');
    expect(res.items[0]).not.toHaveProperty('reason');
    expect(res.allResolved).toBe(true);
  });

  it('classifies OPEN + wedgeReason as deferred and surfaces the reason', () => {
    const subs: ChecklistSubIssue[] = [
      { id: 'b', title: 'wire webhook', status: 'open', wedgeReason: 'blocked on vendor key' },
    ];
    const res = resolveChecklist(subs);

    expect(res.items).toEqual([
      { id: 'b', title: 'wire webhook', state: 'deferred', reason: 'blocked on vendor key' },
    ]);
    expect(res.unresolved).toEqual([]);
    expect(res.allResolved).toBe(true);
  });

  it('classifies IN_PROGRESS + wedgeReason as deferred with reason', () => {
    const subs: ChecklistSubIssue[] = [
      { id: 'c', title: 'migrate table', status: 'in_progress', wedgeReason: 'awaiting review' },
    ];
    const res = resolveChecklist(subs);

    expect(res.items[0]?.state).toBe('deferred');
    expect(res.items[0]?.reason).toBe('awaiting review');
    expect(res.allResolved).toBe(true);
  });

  it('classifies OPEN without a wedgeReason as unresolved (and blocks)', () => {
    const subs: ChecklistSubIssue[] = [{ id: 'd', title: 'silent drop', status: 'open' }];
    const res = resolveChecklist(subs);

    expect(res.items).toEqual([{ id: 'd', title: 'silent drop', state: 'unresolved' }]);
    expect(res.items[0]).not.toHaveProperty('reason');
    expect(res.unresolved).toEqual([{ id: 'd', title: 'silent drop', state: 'unresolved' }]);
    expect(res.allResolved).toBe(false);
  });

  it('classifies IN_PROGRESS without a wedgeReason as unresolved', () => {
    const subs: ChecklistSubIssue[] = [{ id: 'e', title: 'half-done', status: 'in_progress' }];
    const res = resolveChecklist(subs);

    expect(res.items[0]?.state).toBe('unresolved');
    expect(res.allResolved).toBe(false);
  });

  it('treats an empty/whitespace wedgeReason as unresolved, not deferred', () => {
    const subs: ChecklistSubIssue[] = [
      { id: 'f', title: 'empty reason', status: 'open', wedgeReason: '' },
      { id: 'g', title: 'blank reason', status: 'open', wedgeReason: '   ' },
    ];
    const res = resolveChecklist(subs);

    expect(res.items.map((i) => i.state)).toEqual(['unresolved', 'unresolved']);
    expect(res.items[0]).not.toHaveProperty('reason');
    expect(res.unresolved).toHaveLength(2);
    expect(res.allResolved).toBe(false);
  });

  it('resolves an EMPTY committed set trivially (nothing committed, nothing dropped)', () => {
    const res = resolveChecklist([]);

    expect(res.items).toEqual([]);
    expect(res.unresolved).toEqual([]);
    expect(res.allResolved).toBe(true);
  });

  it('in a mixed list, one unresolved blocks while deferred does not', () => {
    const subs: ChecklistSubIssue[] = [
      { id: 'a', title: 'landed', status: 'closed' },
      { id: 'b', title: 'deferred with reason', status: 'open', wedgeReason: 'next sprint' },
      { id: 'c', title: 'silently unresolved', status: 'in_progress' },
    ];
    const res = resolveChecklist(subs);

    expect(res.items.map((i) => i.state)).toEqual(['done', 'deferred', 'unresolved']);

    // reason is present ONLY on the deferred item.
    expect(res.items[0]).not.toHaveProperty('reason');
    expect(res.items[1]?.reason).toBe('next sprint');
    expect(res.items[2]).not.toHaveProperty('reason');

    // Only the silently-unresolved item lands in `unresolved`.
    expect(res.unresolved).toEqual([
      { id: 'c', title: 'silently unresolved', state: 'unresolved' },
    ]);
    expect(res.allResolved).toBe(false);
  });

  it('resolves when every open item is explicitly deferred', () => {
    const subs: ChecklistSubIssue[] = [
      { id: 'a', title: 'closed', status: 'closed' },
      { id: 'b', title: 'deferred', status: 'open', wedgeReason: 'known blocker' },
    ];
    const res = resolveChecklist(subs);

    expect(res.unresolved).toEqual([]);
    expect(res.allResolved).toBe(true);
  });
});
