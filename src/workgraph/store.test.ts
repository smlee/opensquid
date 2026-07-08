/**
 * Tests for the event-sourced work-graph (T-WORKGRAPH-EVENTSOURCED). The 1c behavior (CRUD,
 * ready-derivation, edge guards) must still hold; plus the new op-log: listEvents returns ops,
 * mutations write per-op files under `sourceDir`, and `rebuildWorkGraph` reproduces the projection
 * from those files in Lamport order (incl. LWW on replay). Deterministic fake clock-free logic.
 */
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { rebuildWorkGraph, workGraphStore } from './store.js';

// PLS.2: the store is now PROJECT-LOCAL — ops take no leading `project` arg and the store IS the facade.
const open = async (opts: { dbUrl: string; sourceDir?: string }) => {
  const base = workGraphStore(opts);
  await base.init();
  return base;
};

const fresh = async () => open({ dbUrl: ':memory:' });

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

  it('listEdges returns the folded {from,to,type} triples (T2.5 accessor)', async () => {
    const wg = await fresh();
    const a = await wg.createIssue({ title: 'a' });
    const b = await wg.createIssue({ title: 'b' });
    const c = await wg.createIssue({ title: 'c' });
    await wg.addEdge(a.id, b.id, 'blocks');
    await wg.addEdge(b.id, c.id, 'parent-child');
    const edges = await wg.listEdges();
    expect(edges).toHaveLength(2);
    expect(edges).toContainEqual({ from: a.id, to: b.id, type: 'blocks' });
    expect(edges).toContainEqual({ from: b.id, to: c.id, type: 'parent-child' });
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

// HWS.2 — the store-global op-log cursor + the durable high-water-mark.
describe('workGraphStore op-log cursor (HWS.2)', () => {
  it('listOpsSince(0) returns every op in (lamport, id) order; listOpsSince(max) is empty (no re-emit)', async () => {
    const wg = await fresh();
    const a = await wg.createIssue({ title: 'a' });
    await wg.createIssue({ title: 'b' });
    await wg.updateIssue(a.id, { status: 'closed' });
    const all = await wg.listOpsSince(0);
    expect(all.length).toBeGreaterThanOrEqual(3); // 2× issue_created + 1× issue_set
    // strictly ascending lamport (the store-global monotonic clock) — the exactly-once resume ordering.
    for (let i = 1; i < all.length; i++)
      expect(all[i]!.lamport).toBeGreaterThanOrEqual(all[i - 1]!.lamport);
    const max = Math.max(...all.map((o) => o.lamport));
    expect(await wg.listOpsSince(max)).toEqual([]); // nothing after the last op
  });

  it('the cursor projection matches listEvents (same store-global lamport, no new counter)', async () => {
    const wg = await fresh();
    const a = await wg.createIssue({ title: 'a' });
    await wg.updateIssue(a.id, { status: 'closed' });
    const viaCursor = (await wg.listOpsSince(0))
      .filter((o) => o.issueId === a.id)
      .map((o) => o.lamport);
    const viaEvents = (await wg.listEvents(a.id)).map((o) => o.lamport);
    expect(viaCursor).toEqual(viaEvents); // identical lamports — the cursor reuses wg_ops.lamport
  });

  it('readHighWater is 0 fresh; advanceHighWater is MONOTONIC (a lower value never rewinds it)', async () => {
    const wg = await fresh();
    expect(await wg.readHighWater()).toBe(0); // fresh store → see-everything-once
    await wg.advanceHighWater(5);
    expect(await wg.readHighWater()).toBe(5);
    await wg.advanceHighWater(3); // stale/lower — must NOT rewind
    expect(await wg.readHighWater()).toBe(5);
    await wg.advanceHighWater(9);
    expect(await wg.readHighWater()).toBe(9);
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
    const wg = await open({ dbUrl: `file:${join(dir, 'wg.db')}`, sourceDir: dir });
    const a = await wg.createIssue({ title: 'alpha' });
    const b = await wg.createIssue({ title: 'beta' });
    await wg.addEdge(a.id, b.id, 'blocks');
    await wg.updateIssue(a.id, { status: 'closed' });

    const rebuiltUrl = `file:${join(dir, 'rebuilt.db')}`;
    const n = await rebuildWorkGraph({ dbUrl: rebuiltUrl, sourceDir: dir });
    expect(n).toBe(4); // 2 issue_created + 1 dep_added + 1 issue_set

    const wg2 = await open({ dbUrl: rebuiltUrl });
    expect((await wg2.getIssue(a.id))?.status).toBe('closed');
    // a is closed, so b (blocked only by a) is now ready
    expect((await wg2.listReady()).map((i) => i.id)).toEqual([b.id]);
  });

  it('LWW on replay: the highest-lamport status wins', async () => {
    const wg = await open({ dbUrl: `file:${join(dir, 'wg.db')}`, sourceDir: dir });
    const a = await wg.createIssue({ title: 'x' });
    await wg.updateIssue(a.id, { status: 'in_progress' });
    await wg.updateIssue(a.id, { status: 'closed' });

    const rebuiltUrl = `file:${join(dir, 'r.db')}`;
    await rebuildWorkGraph({ dbUrl: rebuiltUrl, sourceDir: dir });
    const wg2 = await open({ dbUrl: rebuiltUrl });
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
      const wg = await open({ dbUrl: `file:${join(dir, 'wg.db')}`, sourceDir: dir });
      const a = await wg.createIssue({ title: 'persist' });
      await wg.claimIssue(a.id, codex, 86400); // long TTL so it's still live after rebuild
      const rebuiltUrl = `file:${join(dir, 'rebuilt.db')}`;
      await rebuildWorkGraph({ dbUrl: rebuiltUrl, sourceDir: dir });
      const wg2 = await open({ dbUrl: rebuiltUrl });
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
      const wg = await open({ dbUrl: `file:${join(dir, 'wg.db')}`, sourceDir: dir });
      const a = await wg.createIssue({ title: 'wall' });
      expect((await wg.listReady()).map((i) => i.id)).toContain(a.id);
      await wg.wedgeMark(a.id, 'UNRECOVERABLE_WEDGE');
      expect((await wg.listReady()).map((i) => i.id)).not.toContain(a.id);
      expect((await wg.getIssue(a.id))?.wedgeReason).toBe('UNRECOVERABLE_WEDGE');
      // rebuild recognizes wedge_marked (S5-style)
      const rebuiltUrl = `file:${join(dir, 'rebuilt.db')}`;
      await rebuildWorkGraph({ dbUrl: rebuiltUrl, sourceDir: dir });
      const wg2 = await open({ dbUrl: rebuiltUrl });
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
      const wg = await open({ dbUrl: `file:${join(dir, 'wg.db')}`, sourceDir: dir });
      const a = await wg.createIssue({ title: 'wall' });
      await wg.wedgeMark(a.id, 'UNRECOVERABLE_WEDGE');
      expect((await wg.listReady()).map((i) => i.id)).not.toContain(a.id);
      await wg.clearWedge(a.id);
      expect((await wg.getIssue(a.id))?.wedgeReason).toBeUndefined();
      expect((await wg.listReady()).map((i) => i.id)).toContain(a.id); // back in ready
      // rebuild recognizes wedge_cleared (S5-style): the cleared state replays
      const rebuiltUrl = `file:${join(dir, 'rebuilt.db')}`;
      await rebuildWorkGraph({ dbUrl: rebuiltUrl, sourceDir: dir });
      const wg2 = await open({ dbUrl: rebuiltUrl });
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
      const wg = await open({ dbUrl: `file:${join(dir, 'wg.db')}`, sourceDir: dir });
      const a = await wg.createIssue({ title: 'legacy' });
      const rebuiltUrl = `file:${join(dir, 'rebuilt.db')}`;
      await rebuildWorkGraph({ dbUrl: rebuiltUrl, sourceDir: dir });
      const wg2 = await open({ dbUrl: rebuiltUrl });
      const issue = await wg2.getIssue(a.id);
      expect(issue?.claimToken).toBeUndefined();
      expect((await wg2.listReady()).map((i) => i.id)).toContain(a.id);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('workGraphStore migration + replay defaults (PLS.2)', () => {
  const baseOpen = async (opts: { dbUrl: string; sourceDir?: string }) => {
    const b = workGraphStore(opts);
    await b.init();
    return b;
  };

  it('op-ids stay globally unique across issues (one shared Lamport clock)', async () => {
    const base = await baseOpen({ dbUrl: ':memory:' });
    const a = await base.createIssue({ title: 'a' });
    const b = await base.createIssue({ title: 'b' });
    const eventsA = await base.listEvents(a.id);
    const eventsB = await base.listEvents(b.id);
    const ids = [...eventsA, ...eventsB].map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length); // no collision (single clock)
  });

  it('ADD COLUMN migration backfills pre-existing rows to legacy-global', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wg-migrate-'));
    try {
      const dbUrl = `file:${join(dir, 'old.db')}`;
      // Simulate a PRE-project schema (no `project` column) + a legacy row.
      const raw = createClient({ url: dbUrl });
      await raw.execute(
        `CREATE TABLE wg_issues (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          lww INTEGER NOT NULL DEFAULT 0)`,
      );
      await raw.execute({
        sql: `INSERT INTO wg_issues (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
        args: ['wg-legacy', 'old', 't', 't'],
      });
      raw.close();
      // init → createSchema runs the idempotent ALTER TABLE ADD COLUMN ... DEFAULT 'legacy-global'.
      const base = await baseOpen({ dbUrl });
      expect((await base.getIssue('wg-legacy'))?.title).toBe('old');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rebuild from legacy (no-project) op-files folds to legacy-global', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wg-legacy-op-'));
    try {
      // A legacy op-file predates `project` (the field is absent).
      const op = {
        id: 'op-legacy01',
        issueId: 'wg-old',
        lamport: 1,
        type: 'issue_created',
        payload: { title: 'legacy', body: '', ts: '2026-01-01T00:00:00.000Z' },
      };
      await writeFile(join(dir, `${op.id}.json`), JSON.stringify(op));
      const rebuiltUrl = `file:${join(dir, 'rebuilt.db')}`;
      expect(await rebuildWorkGraph({ dbUrl: rebuiltUrl, sourceDir: dir })).toBe(1);
      const base = await baseOpen({ dbUrl: rebuiltUrl });
      expect((await base.getIssue('wg-old'))?.title).toBe('legacy');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('workGraphStore determinism — (lamport, actor-id) tuple (WGD.1)', () => {
  const baseOpen = async (opts: { dbUrl: string; sourceDir?: string; actorId?: string }) => {
    const b = workGraphStore(opts);
    await b.init();
    return b;
  };

  it('ORDER reproducibility: two fresh stores, same create seq → identical order (NOT wall-clock)', async () => {
    const seq = ['gamma', 'alpha', 'beta'];
    const run = async () => {
      const b = await baseOpen({ dbUrl: ':memory:', actorId: 'dev-x' });
      for (const title of seq) await b.createIssue({ title });
      return (await b.listIssues()).map((i) => i.id);
    };
    const first = await run();
    const second = await run();
    expect(second).toEqual(first); // same (created_lamport, actor_id) order, deterministic ids
    expect(first).toHaveLength(3); // listed in creation (lamport) order, not wall-clock/alpha
  });

  it('ID reproducibility (CONTENT ops): same seq + same actorId → identical issue/op ids + op-file names', async () => {
    const dir1 = await mkdtemp(join(tmpdir(), 'wg-det-1-'));
    const dir2 = await mkdtemp(join(tmpdir(), 'wg-det-2-'));
    try {
      const run = async (dir: string) => {
        const b = await baseOpen({
          dbUrl: `file:${join(dir, 'wg.db')}`,
          sourceDir: dir,
          actorId: 'dev-x',
        });
        const a = await b.createIssue({ title: 'a', body: 'A' });
        await b.updateIssue(a.id, { status: 'in_progress' });
        const c = await b.createIssue({ title: 'c' });
        await b.addEdge(a.id, c.id, 'blocks');
        const ops = [...(await b.listEvents(a.id)), ...(await b.listEvents(c.id))];
        return { issueIds: [a.id, c.id], opIds: ops.map((o) => o.id) };
      };
      const r1 = await run(dir1);
      const r2 = await run(dir2);
      expect(r2.issueIds).toEqual(r1.issueIds);
      expect(r2.opIds).toEqual(r1.opIds);
      // op-file names are the op ids — identical across the two independent stores
      expect((await readdir(dir1)).filter((f) => f.endsWith('.json')).sort()).toEqual(
        (await readdir(dir2)).filter((f) => f.endsWith('.json')).sort(),
      );
    } finally {
      await rm(dir1, { recursive: true, force: true });
      await rm(dir2, { recursive: true, force: true });
    }
  });

  it('LEASE carve-out: two stores → DIFFERENT claim_acquired ids; replaying one op-log reproduces its id', async () => {
    const mkStore = async (dir: string) => {
      const b = await baseOpen({
        dbUrl: `file:${join(dir, 'wg.db')}`,
        sourceDir: dir,
        actorId: 'dev-x',
      });
      const a = await b.createIssue({ title: 'claim me' });
      await b.claimIssue(a.id, { source: 'claudecode' }, 1800);
      const claimOp = (await b.listEvents(a.id)).find((o) => o.type === 'claim_acquired');
      return { dir, claimId: claimOp?.id, issueId: a.id };
    };
    const d1 = await mkdtemp(join(tmpdir(), 'wg-lease-1-'));
    const d2 = await mkdtemp(join(tmpdir(), 'wg-lease-2-'));
    try {
      const s1 = await mkStore(d1);
      const s2 = await mkStore(d2);
      // random claimToken (a lease secret) → the two stores' claim-op ids DIFFER (intentional carve-out)
      expect(s1.claimId).not.toBe(s2.claimId);
      // but replaying ONE op-log reproduces ITS stored id exactly (replay reads, never recomputes)
      const rebuiltUrl = `file:${join(d1, 'rebuilt.db')}`;
      await rebuildWorkGraph({ dbUrl: rebuiltUrl, sourceDir: d1 });
      const rb = await baseOpen({ dbUrl: rebuiltUrl });
      const replayed = (await rb.listEvents(s1.issueId)).find((o) => o.type === 'claim_acquired');
      expect(replayed?.id).toBe(s1.claimId);
    } finally {
      await rm(d1, { recursive: true, force: true });
      await rm(d2, { recursive: true, force: true });
    }
  });

  it('CROSS-ACTOR: different actorIds, colliding lamports → distinct content-op ids + deterministic merged order', async () => {
    // Two replicas each emit issue_created at lamport 1 with the SAME content but DIFFERENT actorId.
    const dir = await mkdtemp(join(tmpdir(), 'wg-cross-'));
    try {
      const mk = (actorId: string) => async () => {
        const b = await baseOpen({ dbUrl: ':memory:', actorId });
        const i = await b.createIssue({ title: 'same-title', body: 'same' });
        const op = (await b.listEvents(i.id))[0];
        return { issueId: i.id, opId: op?.id, lamport: op?.lamport, actorId: op?.actorId };
      };
      const a = await mk('actor-aaa')();
      const z = await mk('actor-zzz')();
      // same lamport, same content, but the actor disambiguates → distinct ids (no silent dedupe)
      expect(a.lamport).toBe(z.lamport);
      expect(a.issueId).not.toBe(z.issueId);
      expect(a.opId).not.toBe(z.opId);

      // merge both issue_created op-files into one source dir → deterministic ORDER BY created_lamport, actor_id
      const opFile = (issueId: string, opId: string, actorId: string) => ({
        id: opId,
        issueId,
        lamport: 1,
        type: 'issue_created',
        payload: { title: 'same-title', body: 'same', ts: '2026-01-01T00:00:00.000Z' },
        actorId,
      });
      await writeFile(
        join(dir, `${a.opId}.json`),
        JSON.stringify(opFile(a.issueId, a.opId!, 'actor-aaa')),
      );
      await writeFile(
        join(dir, `${z.opId}.json`),
        JSON.stringify(opFile(z.issueId, z.opId!, 'actor-zzz')),
      );
      const merged = `file:${join(dir, 'merged.db')}`;
      expect(await rebuildWorkGraph({ dbUrl: merged, sourceDir: dir })).toBe(2);
      const mb = await baseOpen({ dbUrl: merged });
      // both distinct issues survive (no INSERT OR IGNORE dedupe) and order by actor_id at the colliding lamport
      const listed = (await mb.listIssues()).map((i) => i.id);
      expect(listed).toEqual([a.issueId, z.issueId]); // actor-aaa < actor-zzz
      expect(listed).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('ts excluded from identity: same (type,payload,lamport,actorId), different ts → same op id; row keeps ts', async () => {
    // Build the SAME op at two different wall-clocks via fake timers; the id must not change.
    const idAt = async (iso: string) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(new Date(iso));
        const b = await baseOpen({ dbUrl: ':memory:', actorId: 'dev-x' });
        const i = await b.createIssue({ title: 'fixed', body: 'fixed' });
        const op = (await b.listEvents(i.id))[0];
        return { id: op?.id, ts: (op?.payload as { ts?: string }).ts };
      } finally {
        vi.useRealTimers();
      }
    };
    const t1 = await idAt('2026-01-01T00:00:00.000Z');
    const t2 = await idAt('2026-09-09T09:09:09.000Z');
    expect(t2.id).toBe(t1.id); // ts NOT in identity
    expect(t1.ts).not.toBe(t2.ts); // but the row/payload keeps the real ts
  });

  it('existing-DB ALTER+backfill: old-schema rows get created_lamport (from issue_created) + actor_id=legacy; idempotent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wg-altbf-'));
    try {
      const dbUrl = `file:${join(dir, 'old.db')}`;
      // Pre-WGD schema: wg_issues without created_lamport/actor_id, wg_ops without actor_id, with a real
      // issue_created op at lamport 7 so the backfill has a non-zero source.
      const raw = createClient({ url: dbUrl });
      await raw.execute(
        `CREATE TABLE wg_issues (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          lww INTEGER NOT NULL DEFAULT 0, project TEXT NOT NULL DEFAULT 'legacy-global')`,
      );
      await raw.execute(
        `CREATE TABLE wg_ops (id TEXT PRIMARY KEY, issue_id TEXT NOT NULL, lamport INTEGER NOT NULL,
          type TEXT NOT NULL, payload TEXT NOT NULL, ts TEXT NOT NULL,
          project TEXT NOT NULL DEFAULT 'legacy-global')`,
      );
      await raw.execute({
        sql: `INSERT INTO wg_issues (id, title, created_at, updated_at, project) VALUES (?, ?, ?, ?, ?)`,
        args: ['wg-old', 'old', 't', 't', 'legacy-global'],
      });
      await raw.execute({
        sql: `INSERT INTO wg_ops (id, issue_id, lamport, type, payload, ts, project) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [
          'op-old01',
          'wg-old',
          7,
          'issue_created',
          JSON.stringify({ title: 'old', body: '', ts: 't' }),
          't',
          'legacy-global',
        ],
      });
      raw.close();

      const probe = async () => {
        const b = createClient({ url: dbUrl });
        const rs = await b.execute(
          `SELECT created_lamport, actor_id FROM wg_issues WHERE id = 'wg-old'`,
        );
        const opRs = await b.execute(`SELECT actor_id FROM wg_ops WHERE id = 'op-old01'`);
        b.close();
        return {
          createdLamport: rs.rows[0]?.created_lamport,
          issueActor: rs.rows[0]?.actor_id,
          opActor: opRs.rows[0]?.actor_id,
        };
      };

      await baseOpen({ dbUrl }); // first init → ALTER + backfill
      const after1 = await probe();
      expect(Number(after1.createdLamport)).toBe(7); // from the issue_created lamport, NOT 0
      expect(after1.issueActor).toBe('legacy');
      expect(after1.opActor).toBe('legacy');

      await baseOpen({ dbUrl }); // re-init → idempotent (no throw, values unchanged)
      const after2 = await probe();
      expect(after2).toEqual(after1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rebuild parity: replay an op-log → identical issues/order/ids', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wg-parity-'));
    try {
      const b = await baseOpen({
        dbUrl: `file:${join(dir, 'wg.db')}`,
        sourceDir: dir,
        actorId: 'dev-x',
      });
      await b.createIssue({ title: 'one' });
      await b.createIssue({ title: 'two' });
      const liveOrder = (await b.listIssues()).map((i) => i.id);

      const rebuiltUrl = `file:${join(dir, 'rebuilt.db')}`;
      await rebuildWorkGraph({ dbUrl: rebuiltUrl, sourceDir: dir });
      const rb = await baseOpen({ dbUrl: rebuiltUrl });
      expect((await rb.listIssues()).map((i) => i.id)).toEqual(liveOrder);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('listEvents read-back carries actorId (X for a stamped op, legacy for a NULL row)', async () => {
    const b = await baseOpen({ dbUrl: ':memory:', actorId: 'dev-X' });
    const i = await b.createIssue({ title: 'e' });
    const op = (await b.listEvents(i.id))[0];
    expect(op?.actorId).toBe('dev-X');

    // a legacy NULL row → 'legacy' on read-back (replay default)
    const dir = await mkdtemp(join(tmpdir(), 'wg-evt-legacy-'));
    try {
      const legacyOp = {
        id: 'op-legacyactor',
        issueId: 'wg-leg',
        lamport: 1,
        type: 'issue_created',
        payload: { title: 'leg', body: '', ts: '2026-01-01T00:00:00.000Z' },
        // no actorId field
      };
      await writeFile(join(dir, `${legacyOp.id}.json`), JSON.stringify(legacyOp));
      const rebuiltUrl = `file:${join(dir, 'rebuilt.db')}`;
      await rebuildWorkGraph({ dbUrl: rebuiltUrl, sourceDir: dir });
      const rb = await baseOpen({ dbUrl: rebuiltUrl });
      const ev = (await rb.listEvents('wg-leg'))[0];
      expect(ev?.actorId).toBe('legacy');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// GS-durability — the live append path allocates the Lamport clock atomically from the DB inside a
// BEGIN IMMEDIATE transaction, so concurrent writers (esp. separate processes sharing one workgraph.db)
// can never mint the same (lamport, actorId) → no duplicate content-hashed wg_ops.id. These tests
// reproduce the old crash shape and assert it no longer happens.
describe('GS-durability — atomic Lamport under concurrency', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wg-conc-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('concurrent appends on one store get unique, gapless lamports (no PK crash)', async () => {
    const wg = await open({ dbUrl: `file:${join(dir, 'wg.db')}` });
    const N = 25;
    const issues = await Promise.all(
      Array.from({ length: N }, (_, i) => wg.createIssue({ title: `t${i}` })),
    );
    expect(new Set(issues.map((i) => i.id)).size).toBe(N); // all ids distinct
    const allOps = (await Promise.all(issues.map((i) => wg.listEvents(i.id)))).flat();
    const lamports = allOps.map((o) => o.lamport).sort((a, b) => a - b);
    expect(lamports).toEqual(Array.from({ length: N }, (_, i) => i + 1)); // 1..N, gapless, no dup
  });

  it('two instances on ONE file share the DB clock — no collision even on identical payloads', async () => {
    const dbUrl = `file:${join(dir, 'wg.db')}`;
    const a = await open({ dbUrl, sourceDir: join(dir, 'ops') });
    const b = await open({ dbUrl, sourceDir: join(dir, 'ops') }); // both init'd — old in-memory hwm both = 0
    // The exact old-crash shape, deterministic: two instances (default actorId 'legacy') creating
    // IDENTICAL-payload issues, alternating. Old code → both seed hwm from MAX at init, both mint the
    // same lamport → same newIssueId + same op-id → SQLITE_CONSTRAINT_PRIMARYKEY on wg_ops.id. New code
    // → each append reads MAX from the SHARED file, so b continues a's clock → distinct lamports → ids.
    const created = [];
    for (let i = 0; i < 8; i++) {
      created.push(await (i % 2 === 0 ? a : b).createIssue({ title: 'same', body: 'same' }));
    }
    expect(new Set(created.map((x) => x.id)).size).toBe(8); // distinct despite identical payloads
    const c = await open({ dbUrl });
    expect(await c.listIssues()).toHaveLength(8);
    const lamports = (await Promise.all(created.map((x) => c.listEvents(x.id))))
      .flat()
      .map((o) => o.lamport)
      .sort((p, q) => p - q);
    expect(lamports).toEqual([1, 2, 3, 4, 5, 6, 7, 8]); // one shared, gapless clock across both writers
  });

  it(
    'two instances writing SIMULTANEOUSLY neither crash nor hang',
    { timeout: 30000 },
    async () => {
      const dbUrl = `file:${join(dir, 'wg.db')}`;
      const a = await open({ dbUrl, sourceDir: join(dir, 'ops') });
      const b = await open({ dbUrl, sourceDir: join(dir, 'ops') });
      // Real simultaneous cross-connection contention (the ralph-parent + lap-subprocess shape). The file
      // write lock serializes the two BEGIN IMMEDIATE writers; busy_timeout + the append retry absorb the
      // wait. Assert: every op lands, all ids distinct — no PK crash, no deadlock.
      const M = 12;
      const issues = await Promise.all(
        Array.from({ length: M }, (_, i) =>
          (i % 2 === 0 ? a : b).createIssue({ title: 'x', body: 'y' }),
        ),
      );
      expect(new Set(issues.map((i) => i.id)).size).toBe(M);
      const c = await open({ dbUrl });
      expect(await c.listIssues()).toHaveLength(M);
    },
  );
});

// WGL.1 (wg-141e0ffd9955) — soft-archive terminal state: a new reversible op, LWW, surviving replay; the row
// is KEPT (history), filtered off listReady, and an archived BLOCKER no longer blocks its consumer.
describe('workGraphStore soft-archive (WGL.1)', () => {
  it('archiveIssue → archived (row kept, in the op-log); listReady excludes it; unarchive restores open', async () => {
    const wg = await fresh();
    const a = await wg.createIssue({ title: 'stub', body: 'x' });
    await wg.archiveIssue(a.id, 'reaped');
    const arch = await wg.getIssue(a.id);
    expect(arch?.status).toBe('archived');
    expect(arch?.archiveReason).toBe('reaped');
    expect(await wg.listIssues()).toHaveLength(1); // row KEPT, not deleted
    expect((await wg.listEvents(a.id)).map((o) => o.type)).toEqual([
      'issue_created',
      'issue_archived',
    ]);
    expect((await wg.listReady()).map((i) => i.id)).not.toContain(a.id);

    await wg.unarchiveIssue(a.id);
    const un = await wg.getIssue(a.id);
    expect(un?.status).toBe('open');
    expect(un?.archiveReason).toBeUndefined(); // cleared
    expect((await wg.listReady()).map((i) => i.id)).toContain(a.id);
  });

  it('an archived BLOCKER no longer blocks its consumer (listReady NOT IN (closed,archived))', async () => {
    const wg = await fresh();
    const blocker = await wg.createIssue({ title: 'A' });
    const consumer = await wg.createIssue({ title: 'B' });
    await wg.addEdge(blocker.id, consumer.id, 'blocks');
    expect((await wg.listReady()).map((i) => i.id)).toEqual([blocker.id]); // B blocked
    await wg.archiveIssue(blocker.id, 'superseded');
    expect((await wg.listReady()).map((i) => i.id)).toEqual([consumer.id]); // B unblocked by the archive
  });

  it('archiveIssue/unarchiveIssue reject a missing id', async () => {
    const wg = await fresh();
    await expect(wg.archiveIssue('wg-nope')).rejects.toThrow(/no issue/);
    await expect(wg.unarchiveIssue('wg-nope')).rejects.toThrow(/no issue/);
  });

  it('archive SURVIVES rebuild replay (event-sourcing integrity — a new op the replay re-folds)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wgl-arch-'));
    try {
      const wg = await open({ dbUrl: `file:${join(dir, 'wg.db')}`, sourceDir: dir });
      const a = await wg.createIssue({ title: 'x' });
      await wg.archiveIssue(a.id, 'reaped');
      const rebuiltUrl = `file:${join(dir, 'rebuilt.db')}`;
      await rebuildWorkGraph({ dbUrl: rebuiltUrl, sourceDir: dir });
      const wg2 = await open({ dbUrl: rebuiltUrl });
      expect((await wg2.getIssue(a.id))?.status).toBe('archived'); // reconstructed from the op-files
      expect((await wg2.getIssue(a.id))?.archiveReason).toBe('reaped');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('LWW: the highest-lamport archive/unarchive wins on replay (unarchive after archive → open)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wgl-lww-'));
    try {
      const wg = await open({ dbUrl: `file:${join(dir, 'wg.db')}`, sourceDir: dir });
      const a = await wg.createIssue({ title: 'x' });
      await wg.archiveIssue(a.id, 'r'); // lamport N
      await wg.unarchiveIssue(a.id); // lamport N+1 (later → wins)
      const rebuiltUrl = `file:${join(dir, 'r.db')}`;
      await rebuildWorkGraph({ dbUrl: rebuiltUrl, sourceDir: dir });
      const wg2 = await open({ dbUrl: rebuiltUrl });
      expect((await wg2.getIssue(a.id))?.status).toBe('open'); // the later op wins under LWW
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
