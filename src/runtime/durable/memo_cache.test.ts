/**
 * Tests for `MemoCache` (DURABLE.3).
 *
 * Coverage mirrors the spec's acceptance criteria + risk callouts:
 *
 *   1. Hit / miss — same (fn, inputs_hash) → cached value; different
 *      hash → miss.
 *   2. TTL expiry — memory + libsql tiers both honor the per-entry TTL.
 *   3. Daemon restart — memory tier rebuilds from libsql on first read; the
 *      persistent row preserves the cached value across `client.close()`.
 *   4. Singleflight — 100 concurrent misses on the same key produce
 *      exactly one `compute()` invocation.
 *   5. Tier coherence — a libsql hit populates the memory tier.
 *   6. Large-output eviction — memory tier respects `memoryMax`; libsql tier
 *      retains the row.
 *   7. `clear({ fn })` — invalidates entries scoped to a single primitive
 *      across both tiers.
 *   8. `clear({ olderThanMs })` — invalidates older-than entries.
 *   9. `stats()` — surfaces per-primitive hit + size counts.
 *  10. Init idempotency — calling `init()` twice doesn't blow up.
 *
 * Each test uses an in-memory libsql (`:memory:`) for speed; the
 * restart-survival test uses a `file:` URL with a tmpdir.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoCache } from './memo_cache.js';

import type { Client } from '@libsql/client';

describe('MemoCache — hit / miss + tier coherence', () => {
  let client: Client;
  beforeEach(() => {
    client = createClient({ url: ':memory:' });
  });
  afterEach(() => {
    client.close();
  });

  it('miss returns null; set then get hits the memory tier', async () => {
    const cache = new MemoCache(client);
    expect(await cache.get('llm_classify', 'h0')).toBeNull();

    await cache.set('llm_classify', 'h0', { label: 'FOO' });
    const hit = await cache.get('llm_classify', 'h0');
    expect(hit).not.toBeNull();
    expect(hit?.value).toEqual({ label: 'FOO' });
  });

  it('different inputs_hash → different cache key, separate values', async () => {
    const cache = new MemoCache(client);
    await cache.set('llm_classify', 'h0', 'A');
    await cache.set('llm_classify', 'h1', 'B');
    expect((await cache.get('llm_classify', 'h0'))?.value).toBe('A');
    expect((await cache.get('llm_classify', 'h1'))?.value).toBe('B');
  });

  it('different fn → different cache key, separate values', async () => {
    const cache = new MemoCache(client);
    await cache.set('llm_classify', 'same', 'classified');
    await cache.set('recall', 'same', 'recalled');
    expect((await cache.get('llm_classify', 'same'))?.value).toBe('classified');
    expect((await cache.get('recall', 'same'))?.value).toBe('recalled');
  });

  it('cached `null` is distinguishable from a miss', async () => {
    const cache = new MemoCache(client);
    await cache.set('fn', 'h', null);
    const hit = await cache.get('fn', 'h');
    expect(hit).not.toBeNull();
    expect(hit?.value).toBeNull();
  });

  it('libsql hit populates the memory tier (tier coherence)', async () => {
    let now = 1_000_000;
    const cache = new MemoCache(client, { nowMs: () => now });
    await cache.set('llm_classify', 'h', { label: 'FOO' });

    // Clear ONLY memory by constructing a fresh cache around the same db —
    // forces the next `get()` to hit libsql + restore memory.
    const cache2 = new MemoCache(client, { nowMs: () => now });
    now += 10;
    const hit1 = await cache2.get('llm_classify', 'h');
    expect(hit1?.value).toEqual({ label: 'FOO' });

    // Close the client — a memory-tier hit must not need libsql.
    client.close();
    now += 10;
    const hit2 = await cache2.get('llm_classify', 'h');
    expect(hit2?.value).toEqual({ label: 'FOO' });
  });
});

describe('MemoCache — TTL expiry', () => {
  let client: Client;
  beforeEach(() => {
    client = createClient({ url: ':memory:' });
  });
  afterEach(() => {
    client.close();
  });

  it('memory tier expires when expiresAtMs passes', async () => {
    let now = 1_000_000;
    const cache = new MemoCache(client, { nowMs: () => now });
    await cache.set('llm_classify', 'h', 'fresh', 60_000); // TTL 60s

    // Within TTL — hit.
    now += 30_000;
    expect((await cache.get('llm_classify', 'h'))?.value).toBe('fresh');

    // Past TTL — miss.
    now += 60_000;
    expect(await cache.get('llm_classify', 'h')).toBeNull();
  });

  it('libsql tier expires when row TTL passes (fresh cache, same db)', async () => {
    let now = 1_000_000;
    const cache = new MemoCache(client, { nowMs: () => now });
    await cache.set('llm_classify', 'h', 'fresh', 60_000);

    // Fresh cache simulates a daemon restart that drops the memory tier
    // but keeps the libsql row.
    const cache2 = new MemoCache(client, { nowMs: () => now });
    now += 30_000;
    expect((await cache2.get('llm_classify', 'h'))?.value).toBe('fresh');

    // Past TTL — libsql tier returns null AND deletes the tombstone.
    now += 60_000;
    expect(await cache2.get('llm_classify', 'h')).toBeNull();
    const rs = await client.execute(
      'SELECT COUNT(*) AS n FROM memo_cache WHERE fn = ? AND inputs_hash = ?',
    );
    expect(Number(rs.rows[0]?.n ?? 0)).toBe(0);
  });

  it('no TTL → entry lives indefinitely', async () => {
    let now = 1_000_000;
    const cache = new MemoCache(client, { nowMs: () => now });
    await cache.set('llm_classify', 'h', 'fresh');

    now += 24 * 3_600_000; // +1 day
    expect((await cache.get('llm_classify', 'h'))?.value).toBe('fresh');
  });
});

describe('MemoCache — singleflight (stampede protection)', () => {
  let client: Client;
  beforeEach(() => {
    client = createClient({ url: ':memory:' });
  });
  afterEach(() => {
    client.close();
  });

  it('100 concurrent misses on the same key produce exactly 1 invocation', async () => {
    const cache = new MemoCache(client);
    let invocations = 0;
    const compute = vi.fn(async (): Promise<string> => {
      invocations += 1;
      // Yield so all 100 callers can queue on the inflight Promise before
      // it resolves. Without this yield the first caller could synchronously
      // resolve and the next 99 would each start a fresh compute.
      await new Promise((r) => setTimeout(r, 10));
      return 'ok';
    });

    const racers = Array.from({ length: 100 }, () =>
      cache.singleflight('llm_classify', 'h', compute),
    );
    const results = await Promise.all(racers);

    expect(invocations).toBe(1);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(results).toEqual(Array(100).fill('ok'));
  });

  it('inflight record clears on success — next miss runs a fresh compute', async () => {
    const cache = new MemoCache(client);
    let invocations = 0;
    const compute = (): Promise<string> => {
      invocations += 1;
      return Promise.resolve('v');
    };

    await cache.singleflight('llm_classify', 'h', compute);
    await cache.singleflight('llm_classify', 'h', compute);
    expect(invocations).toBe(2);
  });

  it('inflight record clears on rejection — next caller is not poisoned', async () => {
    const cache = new MemoCache(client);
    let invocations = 0;
    const boom = (): Promise<string> => {
      invocations += 1;
      return Promise.reject(new Error('boom'));
    };

    await expect(cache.singleflight('llm_classify', 'h', boom)).rejects.toThrow('boom');
    await expect(cache.singleflight('llm_classify', 'h', boom)).rejects.toThrow('boom');
    expect(invocations).toBe(2);
  });
});

describe('MemoCache — restart survival', () => {
  let dir: string;
  let dbPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'opensquid-memo-'));
    dbPath = join(dir, 'memo.db');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('memory empty after restart; first get is libsql hit + restores memory', async () => {
    const c1 = createClient({ url: `file:${dbPath}` });
    const cache1 = new MemoCache(c1);
    await cache1.set('llm_classify', 'h', { label: 'KEEP' });
    c1.close();

    // Fresh client + fresh cache instance — memory tier is empty by
    // construction. The first read MUST hit the persistent tier.
    const c2 = createClient({ url: `file:${dbPath}` });
    const cache2 = new MemoCache(c2);
    const hit = await cache2.get('llm_classify', 'h');
    expect(hit?.value).toEqual({ label: 'KEEP' });

    // Second read AFTER closing the client — confirms the libsql hit
    // populated the memory tier on the first read.
    c2.close();
    const hit2 = await cache2.get('llm_classify', 'h');
    expect(hit2?.value).toEqual({ label: 'KEEP' });
  });

  it('round-trips Buffer through the persistent tier', async () => {
    const c1 = createClient({ url: `file:${dbPath}` });
    const cache1 = new MemoCache(c1);
    await cache1.set('http_request', 'h', Buffer.from('hello', 'utf8'));
    c1.close();

    const c2 = createClient({ url: `file:${dbPath}` });
    const cache2 = new MemoCache(c2);
    const hit = await cache2.get('http_request', 'h');
    expect(Buffer.isBuffer(hit?.value)).toBe(true);
    expect((hit?.value as Buffer).toString('utf8')).toBe('hello');
    c2.close();
  });
});

describe('MemoCache — clear', () => {
  let client: Client;
  beforeEach(() => {
    client = createClient({ url: ':memory:' });
  });
  afterEach(() => {
    client.close();
  });

  it('clear({ fn }) removes all entries for that primitive, leaves others', async () => {
    const cache = new MemoCache(client);
    await cache.set('llm_classify', 'h0', 'A');
    await cache.set('llm_classify', 'h1', 'B');
    await cache.set('recall', 'h0', 'rag');

    const removed = await cache.clear({ fn: 'llm_classify' });
    expect(removed).toBe(2);
    expect(await cache.get('llm_classify', 'h0')).toBeNull();
    expect(await cache.get('llm_classify', 'h1')).toBeNull();
    expect((await cache.get('recall', 'h0'))?.value).toBe('rag');
  });

  it('clear({ olderThanMs }) removes entries cached before the cutoff', async () => {
    let now = 1_000_000;
    const cache = new MemoCache(client, { nowMs: () => now });
    await cache.set('llm_classify', 'old1', 'A');
    await cache.set('llm_classify', 'old2', 'B');

    now += 7 * 86_400_000; // +7 days
    await cache.set('llm_classify', 'recent', 'C');
    // Advance one extra ms so the cutoff strictly exceeds the old rows'
    // cached_at_ms (DELETE predicate is `<`, not `<=`).
    now += 1;

    const removed = await cache.clear({ olderThanMs: 7 * 86_400_000 });
    expect(removed).toBe(2);
    expect(await cache.get('llm_classify', 'old1')).toBeNull();
    expect(await cache.get('llm_classify', 'old2')).toBeNull();
    expect((await cache.get('llm_classify', 'recent'))?.value).toBe('C');
  });

  it('clear({}) wipes everything', async () => {
    const cache = new MemoCache(client);
    await cache.set('llm_classify', 'h', 'A');
    await cache.set('recall', 'h', 'B');

    const removed = await cache.clear({});
    expect(removed).toBe(2);
    expect(await cache.get('llm_classify', 'h')).toBeNull();
    expect(await cache.get('recall', 'h')).toBeNull();
  });
});

describe('MemoCache — large-output / LRU eviction', () => {
  let client: Client;
  beforeEach(() => {
    client = createClient({ url: ':memory:' });
  });
  afterEach(() => {
    client.close();
  });

  it('memory tier evicts oldest beyond memoryMax; libsql tier still hits', async () => {
    const cache = new MemoCache(client, { memoryMax: 3 });
    await cache.set('fn', 'k0', 'v0');
    await cache.set('fn', 'k1', 'v1');
    await cache.set('fn', 'k2', 'v2');
    // Fourth entry evicts the oldest (k0) from the memory tier.
    await cache.set('fn', 'k3', 'v3');

    // The libsql tier still has k0; the get() falls through and restores it
    // to the memory tier.
    const hit = await cache.get('fn', 'k0');
    expect(hit?.value).toBe('v0');

    // Confirm libsql still has all four rows.
    const rs = await client.execute('SELECT COUNT(*) AS n FROM memo_cache');
    expect(Number(rs.rows[0]?.n ?? 0)).toBe(4);
  });
});

describe('MemoCache — stats + init', () => {
  let client: Client;
  beforeEach(() => {
    client = createClient({ url: ':memory:' });
  });
  afterEach(() => {
    client.close();
  });

  it('stats() returns per-primitive hits + live size (TTL-respecting)', async () => {
    let now = 1_000_000;
    const cache = new MemoCache(client, { nowMs: () => now });
    await cache.set('llm_classify', 'h0', 'A', 60_000);
    await cache.set('llm_classify', 'h1', 'B'); // no TTL → indefinite
    await cache.set('recall', 'h0', 'rag', 60_000);

    // hit_count is bumped only on persistent-tier hits (memory-tier hits
    // happen too quickly to be worth round-tripping a write). Use a fresh
    // MemoCache against the same db so each `get()` falls through to libsql.
    const reader1 = new MemoCache(client, { nowMs: () => now });
    await reader1.get('llm_classify', 'h0');
    const reader2 = new MemoCache(client, { nowMs: () => now });
    await reader2.get('llm_classify', 'h0');

    // Cross the TTL — the llm_classify h0 row + recall h0 expire; h1 (no
    // TTL) stays. Expired rows that haven't been read are NOT auto-pruned
    // by stats(); we count by predicate.
    now += 120_000;

    const stats = await cache.stats();
    const byFn = Object.fromEntries(stats.map((s) => [s.fn, s]));
    // hits is a running counter — survives the TTL.
    expect(byFn.llm_classify?.hits).toBe(2);
    // size = live rows: only h1 (no TTL).
    expect(byFn.llm_classify?.size).toBe(1);
    expect(byFn.recall?.size).toBe(0);
  });

  it('init is idempotent', async () => {
    const cache = new MemoCache(client);
    await cache.init();
    await cache.init();
    await cache.set('fn', 'h', 'v');
    expect((await cache.get('fn', 'h'))?.value).toBe('v');
  });
});
