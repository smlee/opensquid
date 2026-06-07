/**
 * Tests for the libSQL work-graph (T-WORKGRAPH-CORE). All against an in-memory DB. Covers the
 * CRUD round-trip, the append-only event log, addEdge guards, and — the headline — that
 * `listReady` derives blocked-ness purely from edges (blocked is never stored), including the
 * cycle case (no hang) and status filtering.
 */
import { describe, expect, it } from 'vitest';

import { workGraphStore } from './store.js';

const fresh = async () => {
  const wg = workGraphStore({ dbUrl: ':memory:' });
  await wg.init();
  return wg;
};

describe('workGraphStore', () => {
  it('createIssue → getIssue round-trip + listIssues filter', async () => {
    const wg = await fresh();
    const a = await wg.createIssue({ title: 'first', body: 'do it' });
    expect(a.id.startsWith('wg-')).toBe(true);
    expect(a.status).toBe('open');
    expect(await wg.getIssue(a.id)).toEqual(a);
    await wg.createIssue({ title: 'second' });
    expect(await wg.listIssues()).toHaveLength(2);
    expect(await wg.listIssues({ status: 'closed' })).toHaveLength(0);
  });

  it('updateIssue persists + appends a status_changed event', async () => {
    const wg = await fresh();
    const a = await wg.createIssue({ title: 'x' });
    await wg.updateIssue(a.id, { status: 'in_progress' });
    expect((await wg.getIssue(a.id))?.status).toBe('in_progress');
    const events = await wg.listEvents(a.id);
    expect(events.map((e) => e.kind)).toEqual(['created', 'status_changed']);
    expect(events[1]?.data).toEqual({ from: 'open', to: 'in_progress' });
  });

  it('addEdge guards self / missing endpoint / bad type, and is idempotent', async () => {
    const wg = await fresh();
    const a = await wg.createIssue({ title: 'a' });
    const b = await wg.createIssue({ title: 'b' });
    await expect(wg.addEdge(a.id, a.id, 'blocks')).rejects.toThrow(/self-edge/);
    await expect(wg.addEdge(a.id, 'wg-nope', 'blocks')).rejects.toThrow(/endpoint missing/);
    await expect(wg.addEdge(a.id, b.id, 'bogus' as never)).rejects.toThrow(/bad edge type/);
    await wg.addEdge(a.id, b.id, 'blocks');
    await wg.addEdge(a.id, b.id, 'blocks'); // idempotent — no throw
  });

  it('listReady derives blocked-ness from edges (blocker open → not ready; closed → ready)', async () => {
    const wg = await fresh();
    const blocker = await wg.createIssue({ title: 'blocker' });
    const blocked = await wg.createIssue({ title: 'blocked' });
    expect((await wg.listReady()).map((i) => i.id).sort()).toEqual([blocker.id, blocked.id].sort());
    await wg.addEdge(blocker.id, blocked.id, 'blocks');
    expect((await wg.listReady()).map((i) => i.id)).toEqual([blocker.id]);
    await wg.updateIssue(blocker.id, { status: 'closed' });
    expect((await wg.listReady()).map((i) => i.id)).toEqual([blocked.id]);
  });

  it('cyclic blocks → neither ready (no hang); in_progress excluded', async () => {
    const wg = await fresh();
    const a = await wg.createIssue({ title: 'a' });
    const b = await wg.createIssue({ title: 'b' });
    await wg.addEdge(a.id, b.id, 'blocks');
    await wg.addEdge(b.id, a.id, 'blocks');
    expect(await wg.listReady()).toHaveLength(0);
    const c = await wg.createIssue({ title: 'c' });
    await wg.updateIssue(c.id, { status: 'in_progress' });
    expect((await wg.listReady()).map((i) => i.id)).not.toContain(c.id);
  });
});
