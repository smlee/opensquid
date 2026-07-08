/**
 * WGL.5 (wg-141e0ffd9955) — parent roll-up. Proves a parent auto-closes once EVERY child is non-drivable
 * (closed/archived/wedged), the upward recursion, the childless guard, and the wedge-preservation invariant
 * (a wedged child does not hold the parent open yet keeps its `wedgeReason`), over a real `:memory:` store.
 */
import { describe, expect, it } from 'vitest';

import { workGraphStore } from '../../workgraph/store.js';

import { rollUpParents } from './parent_rollup.js';

const fresh = async () => {
  const s = workGraphStore({ dbUrl: ':memory:' });
  await s.init();
  return s;
};

describe('rollUpParents (WGL.5)', () => {
  it('closes the parent only once ALL children are non-drivable', async () => {
    const s = await fresh();
    const P = await s.createIssue({ title: 'P', body: '' });
    const C1 = await s.createIssue({ title: 'C1', body: '' });
    const C2 = await s.createIssue({ title: 'C2', body: '' });
    await s.addEdge(P.id, C1.id, 'parent-child');
    await s.addEdge(P.id, C2.id, 'parent-child');

    await s.updateIssue(C1.id, { status: 'closed' });
    expect(await rollUpParents(s, C1.id)).toEqual([]); // C2 still drivable → P stays open
    expect((await s.getIssue(P.id))?.status).toBe('open');

    await s.updateIssue(C2.id, { status: 'closed' });
    expect(await rollUpParents(s, C2.id)).toEqual([P.id]); // all children terminal → roll up
    expect((await s.getIssue(P.id))?.status).toBe('closed');
  });

  it('an archived child counts as non-drivable', async () => {
    const s = await fresh();
    const P = await s.createIssue({ title: 'P', body: '' });
    const C1 = await s.createIssue({ title: 'C1', body: '' });
    const C2 = await s.createIssue({ title: 'C2', body: '' });
    await s.addEdge(P.id, C1.id, 'parent-child');
    await s.addEdge(P.id, C2.id, 'parent-child');
    await s.updateIssue(C1.id, { status: 'closed' });
    await s.archiveIssue(C2.id, 'superseded');
    expect(await rollUpParents(s, C1.id)).toEqual([P.id]);
    expect((await s.getIssue(P.id))?.status).toBe('closed');
  });

  it('a wedged child does NOT hold the parent open AND keeps its wedgeReason (never buried)', async () => {
    const s = await fresh();
    const P = await s.createIssue({ title: 'P', body: '' });
    const C1 = await s.createIssue({ title: 'C1', body: '' });
    const C2 = await s.createIssue({ title: 'C2', body: '' });
    await s.addEdge(P.id, C1.id, 'parent-child');
    await s.addEdge(P.id, C2.id, 'parent-child');
    await s.updateIssue(C1.id, { status: 'closed' });
    await s.wedgeMark(C2.id, 'stuck on a boundary');
    expect(await rollUpParents(s, C1.id)).toEqual([P.id]);
    expect((await s.getIssue(P.id))?.status).toBe('closed');
    expect((await s.getIssue(C2.id))?.wedgeReason).toBe('stuck on a boundary'); // intact — not cleared
  });

  it('recurses grand-parent → parent → child', async () => {
    const s = await fresh();
    const G = await s.createIssue({ title: 'G', body: '' });
    const P = await s.createIssue({ title: 'P', body: '' });
    const C = await s.createIssue({ title: 'C', body: '' });
    await s.addEdge(G.id, P.id, 'parent-child');
    await s.addEdge(P.id, C.id, 'parent-child');
    await s.updateIssue(C.id, { status: 'closed' });
    expect(await rollUpParents(s, C.id)).toEqual([P.id, G.id]);
    expect((await s.getIssue(G.id))?.status).toBe('closed');
  });

  it('does NOT close a parent with a still-drivable child; a childless leaf is never rolled up', async () => {
    const s = await fresh();
    const P = await s.createIssue({ title: 'P', body: '' });
    const C1 = await s.createIssue({ title: 'C1', body: '' });
    const C2 = await s.createIssue({ title: 'C2', body: '' });
    await s.addEdge(P.id, C1.id, 'parent-child');
    await s.addEdge(P.id, C2.id, 'parent-child');
    await s.updateIssue(C1.id, { status: 'closed' });
    expect(await rollUpParents(s, C1.id)).toEqual([]); // C2 open+non-wedged → no premature close
    const leaf = await s.createIssue({ title: 'leaf', body: '' });
    expect(await rollUpParents(s, leaf.id)).toEqual([]); // childless guard — `every([])` never closes a leaf
  });
});
