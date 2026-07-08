/**
 * WGL.4 (wg-141e0ffd9955) — the GC reaper. Proves the narrow orphan definition (open + `sourceElementId:` body
 * + no incoming parent-child edge), soft-archive drain, and idempotency, over a real `:memory:` workGraphStore.
 */
import { describe, expect, it } from 'vitest';

import { workGraphStore } from '../../workgraph/store.js';

import { isOrphan, reapOrphans } from './reaper.js';

const fresh = async () => {
  const s = workGraphStore({ dbUrl: ':memory:' });
  await s.init();
  return s;
};

describe('reaper (WGL.4)', () => {
  it('archives ONLY the open ownerless sourceElementId stub; leaves owned children, real tasks, terminal items', async () => {
    const s = await fresh();
    const parent = await s.createIssue({ title: 'parent', body: '' });
    const orphan = await s.createIssue({ title: 'orphan', body: 'sourceElementId:scope-1' });
    const owned = await s.createIssue({ title: 'owned', body: 'sourceElementId:scope-2' });
    await s.addEdge(parent.id, owned.id, 'parent-child'); // owned = has a live owner
    const realTask = await s.createIssue({ title: 'real', body: 'a genuine human ask' });
    const closedStub = await s.createIssue({ title: 'closed', body: 'sourceElementId:scope-3' });
    await s.updateIssue(closedStub.id, { status: 'closed' });

    const reaped = await reapOrphans(s);
    expect(reaped).toEqual([orphan.id]);
    expect((await s.getIssue(orphan.id))?.status).toBe('archived'); // soft — kept as history
    expect((await s.getIssue(owned.id))?.status).toBe('open'); // owned → untouched
    expect((await s.getIssue(realTask.id))?.status).toBe('open'); // no sourceElementId → untouched
    expect((await s.getIssue(closedStub.id))?.status).toBe('closed'); // already terminal → untouched
    expect((await s.listReady()).map((i) => i.id)).not.toContain(orphan.id); // off ready
  });

  it('is idempotent — a second pass archives nothing (the stub is no longer open)', async () => {
    const s = await fresh();
    await s.createIssue({ title: 'orphan', body: 'sourceElementId:scope-1' });
    expect((await reapOrphans(s)).length).toBe(1);
    expect(await reapOrphans(s)).toEqual([]);
  });

  it('isOrphan unit table: open+sourceElementId+unowned → true; owned/real-task/in_progress → false', () => {
    const owned = new Set(['wg-owned']);
    expect(isOrphan({ id: 'wg-1', status: 'open', body: 'sourceElementId:x' }, owned)).toBe(true);
    expect(isOrphan({ id: 'wg-owned', status: 'open', body: 'sourceElementId:x' }, owned)).toBe(
      false,
    );
    expect(isOrphan({ id: 'wg-2', status: 'open', body: 'a human ask' }, owned)).toBe(false);
    expect(isOrphan({ id: 'wg-3', status: 'in_progress', body: 'sourceElementId:x' }, owned)).toBe(
      false,
    );
    expect(isOrphan({ id: 'wg-4', status: 'archived', body: 'sourceElementId:x' }, owned)).toBe(
      false,
    );
  });
});
