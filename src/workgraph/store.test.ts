/**
 * Tests for the event-sourced work-graph (T-WORKGRAPH-EVENTSOURCED). The 1c behavior (CRUD,
 * ready-derivation, edge guards) must still hold; plus the new op-log: listEvents returns ops,
 * mutations write per-op files under `sourceDir`, and `rebuildWorkGraph` reproduces the projection
 * from those files in Lamport order (incl. LWW on replay). Deterministic fake clock-free logic.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

describe('workGraphStore claim + audience (GR.1)', () => {
  const claude = { source: 'claudecode', version: '1.2.3' } as const;
  const codex = { source: 'codex', threadId: 'abc' } as const;

  it('claimIssue wins on an unclaimed item and removes it from ready', async () => {
    const wg = await fresh();
    const a = await wg.createIssue({ title: 'claim me' });
    const r = await wg.claimIssue(a.id, claude, 1800);
    expect(r.won).toBe(true);
    expect((await wg.listReady()).map((i) => i.id)).not.toContain(a.id);
    expect((await wg.getIssue(a.id))?.claimAudience).toEqual(claude);
    // claim is a status op on the op-log, not a side store
    expect((await wg.listEvents(a.id)).map((o) => o.type)).toEqual([
      'issue_created',
      'claim_acquired',
    ]);
  });

  it('releaseClaim drops the claim → item re-surfaces in ready without a TTL wait (wg-8e1104f1934b)', async () => {
    const wg = await fresh();
    const a = await wg.createIssue({ title: 'release me' });
    await wg.claimIssue(a.id, claude, 86400); // live claim, 1-day TTL → excluded from ready
    expect((await wg.listReady()).map((i) => i.id)).not.toContain(a.id);
    await wg.releaseClaim(a.id);
    // all claim fields nulled — no time advance needed
    expect((await wg.getIssue(a.id))?.claimToken).toBeUndefined();
    expect((await wg.getIssue(a.id))?.claimAudience).toBeUndefined();
    expect((await wg.listReady()).map((i) => i.id)).toContain(a.id);
    expect((await wg.listEvents(a.id)).map((o) => o.type)).toEqual([
      'issue_created',
      'claim_acquired',
      'claim_released',
    ]);
  });

  it('a second concurrent claim loses (exactly-once CAS)', async () => {
    const wg = await fresh();
    const a = await wg.createIssue({ title: 'contended' });
    const first = await wg.claimIssue(a.id, claude, 1800);
    const second = await wg.claimIssue(a.id, codex, 1800);
    expect(first.won).toBe(true);
    expect(second.won).toBe(false);
    // the FIRST claimant's audience stands
    expect((await wg.getIssue(a.id))?.claimAudience).toEqual(claude);
  });

  it('a closed item cannot be claimed (CAS requires status=open)', async () => {
    const wg = await fresh();
    const a = await wg.createIssue({ title: 'done' });
    await wg.updateIssue(a.id, { status: 'closed' });
    expect((await wg.claimIssue(a.id, claude, 1800)).won).toBe(false);
  });

  it('claiming a missing issue throws', async () => {
    const wg = await fresh();
    await expect(wg.claimIssue('wg-nope', claude, 1800)).rejects.toThrow(/no issue/);
  });

  it('an expired claim re-surfaces in ready and is reclaimable (query-time expiry, no reaper)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-06-13T00:00:00.000Z'));
      const wg = await fresh();
      const a = await wg.createIssue({ title: 'ttl' });
      expect((await wg.claimIssue(a.id, claude, 60)).won).toBe(true); // 60s TTL
      expect((await wg.listReady()).map((i) => i.id)).not.toContain(a.id);
      // advance past expiry — no write, just time
      vi.setSystemTime(new Date('2026-06-13T00:01:01.000Z')); // +61s
      expect((await wg.listReady()).map((i) => i.id)).toContain(a.id);
      // a fresh claim wins again (prior claim expired)
      expect((await wg.claimIssue(a.id, codex, 60)).won).toBe(true);
      expect((await wg.getIssue(a.id))?.claimAudience).toEqual(codex);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a claim survives projection rebuild (S5) and stays out of ready', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wg-claim-'));
    try {
      const wg = workGraphStore({ dbUrl: `file:${join(dir, 'wg.db')}`, sourceDir: dir });
      await wg.init();
      const a = await wg.createIssue({ title: 'persist' });
      await wg.claimIssue(a.id, codex, 86400); // long TTL so it's still live after rebuild
      const rebuiltUrl = `file:${join(dir, 'rebuilt.db')}`;
      await rebuildWorkGraph({ dbUrl: rebuiltUrl, sourceDir: dir });
      const wg2 = workGraphStore({ dbUrl: rebuiltUrl });
      await wg2.init();
      const issue = await wg2.getIssue(a.id);
      expect(issue?.claimAudience).toEqual(codex);
      expect(issue?.claimToken).toBeTruthy();
      expect((await wg2.listReady()).map((i) => i.id)).not.toContain(a.id);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('wedgeMark excludes an item from ready (escalate, not re-attempt) — survives rebuild', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wg-wedge-'));
    try {
      const wg = workGraphStore({ dbUrl: `file:${join(dir, 'wg.db')}`, sourceDir: dir });
      await wg.init();
      const a = await wg.createIssue({ title: 'wall' });
      expect((await wg.listReady()).map((i) => i.id)).toContain(a.id);
      await wg.wedgeMark(a.id, 'UNRECOVERABLE_WEDGE');
      expect((await wg.listReady()).map((i) => i.id)).not.toContain(a.id);
      expect((await wg.getIssue(a.id))?.wedgeReason).toBe('UNRECOVERABLE_WEDGE');
      // rebuild recognizes wedge_marked (S5-style)
      const rebuiltUrl = `file:${join(dir, 'rebuilt.db')}`;
      await rebuildWorkGraph({ dbUrl: rebuiltUrl, sourceDir: dir });
      const wg2 = workGraphStore({ dbUrl: rebuiltUrl });
      await wg2.init();
      expect((await wg2.getIssue(a.id))?.wedgeReason).toBe('UNRECOVERABLE_WEDGE');
      expect((await wg2.listReady()).map((i) => i.id)).not.toContain(a.id);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('wedgeMark on a missing issue throws', async () => {
    const wg = await fresh();
    await expect(wg.wedgeMark('wg-nope', 'X')).rejects.toThrow(/no issue/);
  });

  it('clearWedge re-surfaces a wedged item (GR.4 un-wedge) — survives rebuild', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wg-unwedge-'));
    try {
      const wg = workGraphStore({ dbUrl: `file:${join(dir, 'wg.db')}`, sourceDir: dir });
      await wg.init();
      const a = await wg.createIssue({ title: 'wall' });
      await wg.wedgeMark(a.id, 'UNRECOVERABLE_WEDGE');
      expect((await wg.listReady()).map((i) => i.id)).not.toContain(a.id);
      await wg.clearWedge(a.id);
      expect((await wg.getIssue(a.id))?.wedgeReason).toBeUndefined();
      expect((await wg.listReady()).map((i) => i.id)).toContain(a.id); // back in ready
      // rebuild recognizes wedge_cleared (S5-style): the cleared state replays
      const rebuiltUrl = `file:${join(dir, 'rebuilt.db')}`;
      await rebuildWorkGraph({ dbUrl: rebuiltUrl, sourceDir: dir });
      const wg2 = workGraphStore({ dbUrl: rebuiltUrl });
      await wg2.init();
      expect((await wg2.getIssue(a.id))?.wedgeReason).toBeUndefined();
      expect((await wg2.listReady()).map((i) => i.id)).toContain(a.id);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('clearWedge on a missing issue throws', async () => {
    const wg = await fresh();
    await expect(wg.clearWedge('wg-nope')).rejects.toThrow(/no issue/);
  });

  it('old logs WITHOUT claim ops project unchanged (additive)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wg-noclaim-'));
    try {
      const wg = workGraphStore({ dbUrl: `file:${join(dir, 'wg.db')}`, sourceDir: dir });
      await wg.init();
      const a = await wg.createIssue({ title: 'legacy' });
      const rebuiltUrl = `file:${join(dir, 'rebuilt.db')}`;
      await rebuildWorkGraph({ dbUrl: rebuiltUrl, sourceDir: dir });
      const wg2 = workGraphStore({ dbUrl: rebuiltUrl });
      await wg2.init();
      const issue = await wg2.getIssue(a.id);
      expect(issue?.claimToken).toBeUndefined();
      expect((await wg2.listReady()).map((i) => i.id)).toContain(a.id);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
