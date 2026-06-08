/**
 * Tests for the event-sourced work-graph (T-WORKGRAPH-EVENTSOURCED). The 1c behavior (CRUD,
 * ready-derivation, edge guards) must still hold; plus the new op-log: listEvents returns ops,
 * mutations write per-op files under `sourceDir`, and `rebuildWorkGraph` reproduces the projection
 * from those files in Lamport order (incl. LWW on replay). Deterministic fake clock-free logic.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { rebuildWorkGraph, workGraphStore } from './store.js';

const fresh = async () => {
  const wg = workGraphStore({ dbUrl: ':memory:' });
  await wg.init();
  return wg;
};

describe('workGraphStore (event-sourced)', () => {
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

  it('updateIssue projects + appends an issue_set op', async () => {
    const wg = await fresh();
    const a = await wg.createIssue({ title: 'x' });
    await wg.updateIssue(a.id, { status: 'in_progress' });
    expect((await wg.getIssue(a.id))?.status).toBe('in_progress');
    const ops = await wg.listEvents(a.id);
    expect(ops.map((o) => o.type)).toEqual(['issue_created', 'issue_set']);
    expect(ops[1]?.payload.status).toBe('in_progress');
  });

  it('addEdge guards self / missing / bad type, and is idempotent', async () => {
    const wg = await fresh();
    const a = await wg.createIssue({ title: 'a' });
    const b = await wg.createIssue({ title: 'b' });
    await expect(wg.addEdge(a.id, a.id, 'blocks')).rejects.toThrow(/self-edge/);
    await expect(wg.addEdge(a.id, 'wg-nope', 'blocks')).rejects.toThrow(/endpoint missing/);
    await expect(wg.addEdge(a.id, b.id, 'bogus' as never)).rejects.toThrow(/bad edge type/);
    await wg.addEdge(a.id, b.id, 'blocks');
    await wg.addEdge(a.id, b.id, 'blocks'); // idempotent fold (edge_key upsert)
    expect((await wg.listReady()).map((i) => i.id)).toEqual([a.id]);
  });

  it('re-adding an edge with a different type UPDATES it (type excluded from identity)', async () => {
    const wg = await fresh();
    const a = await wg.createIssue({ title: 'a' });
    const b = await wg.createIssue({ title: 'b' });
    await wg.addEdge(a.id, b.id, 'blocks');
    expect((await wg.listReady()).map((i) => i.id)).toEqual([a.id]); // b blocked
    await wg.addEdge(a.id, b.id, 'related'); // re-type same (from,to) → updates to 'related'
    expect((await wg.listReady()).map((i) => i.id)).toEqual([a.id, b.id]); // no longer a 'blocks' edge
  });

  it('listReady derives blocked-ness; closing the blocker frees it', async () => {
    const wg = await fresh();
    const blocker = await wg.createIssue({ title: 'blocker' });
    const blocked = await wg.createIssue({ title: 'blocked' });
    await wg.addEdge(blocker.id, blocked.id, 'blocks');
    expect((await wg.listReady()).map((i) => i.id)).toEqual([blocker.id]);
    await wg.updateIssue(blocker.id, { status: 'closed' });
    expect((await wg.listReady()).map((i) => i.id)).toEqual([blocked.id]);
  });

  it('cyclic blocks → neither ready (no hang)', async () => {
    const wg = await fresh();
    const a = await wg.createIssue({ title: 'a' });
    const b = await wg.createIssue({ title: 'b' });
    await wg.addEdge(a.id, b.id, 'blocks');
    await wg.addEdge(b.id, a.id, 'blocks');
    expect(await wg.listReady()).toHaveLength(0);
  });
});

describe('workGraphStore per-file source + rebuild', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wg-src-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes one op file per mutation and rebuilds the projection from them', async () => {
    const wg = workGraphStore({ dbUrl: `file:${join(dir, 'wg.db')}`, sourceDir: dir });
    await wg.init();
    const a = await wg.createIssue({ title: 'alpha' });
    const b = await wg.createIssue({ title: 'beta' });
    await wg.addEdge(a.id, b.id, 'blocks');
    await wg.updateIssue(a.id, { status: 'closed' });

    const rebuiltUrl = `file:${join(dir, 'rebuilt.db')}`;
    const n = await rebuildWorkGraph({ dbUrl: rebuiltUrl, sourceDir: dir });
    expect(n).toBe(4); // 2 issue_created + 1 dep_added + 1 issue_set

    const wg2 = workGraphStore({ dbUrl: rebuiltUrl });
    await wg2.init();
    expect((await wg2.getIssue(a.id))?.status).toBe('closed');
    // a is closed, so b (blocked only by a) is now ready
    expect((await wg2.listReady()).map((i) => i.id)).toEqual([b.id]);
  });

  it('LWW on replay: the highest-lamport status wins', async () => {
    const wg = workGraphStore({ dbUrl: `file:${join(dir, 'wg.db')}`, sourceDir: dir });
    await wg.init();
    const a = await wg.createIssue({ title: 'x' });
    await wg.updateIssue(a.id, { status: 'in_progress' });
    await wg.updateIssue(a.id, { status: 'closed' });

    const rebuiltUrl = `file:${join(dir, 'r.db')}`;
    await rebuildWorkGraph({ dbUrl: rebuiltUrl, sourceDir: dir });
    const wg2 = workGraphStore({ dbUrl: rebuiltUrl });
    await wg2.init();
    expect((await wg2.getIssue(a.id))?.status).toBe('closed');
  });
});
