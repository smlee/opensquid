/**
 * Tests for `RateLimiter` (AUTO.2).
 *
 * Coverage matches the spec's acceptance criteria + risk callouts:
 *   1. Burst — 10 in 1s passes, 11th denied with retryAfterMs ≈ 5400 for
 *      `max: 10, per: minute`.
 *   2. Refill — wait + retry returns allowed.
 *   3. Concurrent — `concurrent: 1`, two simultaneous `check()` → 2nd denied.
 *   4. Release — frees the concurrent slot; next `check()` allowed.
 *   5. Restart-survival — close client + reopen at same dbUrl → state preserved.
 *   6. Fail-closed — libsql write failure during refill → deny + onError fires.
 *   7. Unconfigured-pack — no rate_limits block = unlimited, no libsql touch.
 *   8. Float clamping — refill never exceeds `max` even after many idle cycles.
 *   9. Release floor — over-releasing never drives concurrent_count below 0.
 *
 * Every test uses a fake clock — no `Date.now()` calls, no
 * `vi.useFakeTimers`. The limiter constructor accepts `now: () => number`;
 * tests advance the clock by reassigning the variable the closure reads.
 *
 * Storage: in-memory libsql (`:memory:`) for fast tests; one test uses a
 * `file:` URL to a tmpdir path so the restart-survival check can re-open
 * the same DB file with a fresh `Client`.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RateLimiter } from './rate_limit.js';

import type { PackRateLimits } from './rate_limit.js';
import type { Client } from '@libsql/client';

// ---------------------------------------------------------------------------
// Fake clock helper — every test that touches time uses one of these.
// ---------------------------------------------------------------------------

function makeClock(startMs: number): { now: () => number; advance: (ms: number) => void } {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe('RateLimiter — token bucket math', () => {
  let client: Client;

  beforeEach(() => {
    client = createClient({ url: ':memory:' });
  });
  afterEach(() => {
    client.close();
  });

  it('burst: 10 consecutive checks pass, 11th denies with retryAfterMs ≈ 5400', async () => {
    const clock = makeClock(1_000_000);
    const limits = new Map<string, PackRateLimits>([
      ['pack-a', { schedule: { max: 10, per: 'minute' } }],
    ]);
    const limiter = new RateLimiter(client, { limits, now: clock.now });

    for (let i = 0; i < 10; i++) {
      const verdict = await limiter.check('pack-a', 'schedule', 'k1');
      expect(verdict.allowed).toBe(true);
      // Each check completes "instantly" — but token bucket is continuous,
      // so we don't manually advance the clock between calls (refill in
      // sub-millisecond windows is effectively zero).
    }

    const denied = await limiter.check('pack-a', 'schedule', 'k1');
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe('rate_exceeded');
    // refill rate = 10 / 60000 ms = 1 token per 6000 ms. With 0 tokens
    // available, retryAfterMs ≈ ceil((1 - 0) / (10/60000)) = 6000.
    // The exact bound is between 5400 and 6000 depending on micro-elapsed
    // ms; the spec calls out ~5400. Assert the spec's loose-bound shape.
    expect(denied.retryAfterMs).toBeGreaterThanOrEqual(5400);
    expect(denied.retryAfterMs).toBeLessThanOrEqual(6000);
  });

  it('refill: after the wait, the next check is allowed', async () => {
    const clock = makeClock(2_000_000);
    const limits = new Map<string, PackRateLimits>([
      ['pack-a', { schedule: { max: 10, per: 'minute' } }],
    ]);
    const limiter = new RateLimiter(client, { limits, now: clock.now });

    for (let i = 0; i < 10; i++) await limiter.check('pack-a', 'schedule', 'k1');
    const denied = await limiter.check('pack-a', 'schedule', 'k1');
    expect(denied.allowed).toBe(false);

    // Wait one full refill window = 60s.
    clock.advance(60_000);

    const allowed = await limiter.check('pack-a', 'schedule', 'k1');
    expect(allowed.allowed).toBe(true);
  });

  it('per-key isolation: different keys do not share the same bucket', async () => {
    const clock = makeClock(3_000_000);
    const limits = new Map<string, PackRateLimits>([
      ['pack-a', { schedule: { max: 1, per: 'minute' } }],
    ]);
    const limiter = new RateLimiter(client, { limits, now: clock.now });

    expect((await limiter.check('pack-a', 'schedule', 'k1')).allowed).toBe(true);
    expect((await limiter.check('pack-a', 'schedule', 'k2')).allowed).toBe(true);
    expect((await limiter.check('pack-a', 'schedule', 'k1')).allowed).toBe(false);
  });

  it('floating-point clamp: tokens never exceed max even after many idle cycles', async () => {
    const clock = makeClock(4_000_000);
    const limits = new Map<string, PackRateLimits>([
      ['pack-a', { schedule: { max: 3, per: 'minute' } }],
    ]);
    const limiter = new RateLimiter(client, { limits, now: clock.now });

    // Burn one token to materialize a row, then idle far past full refill.
    await limiter.check('pack-a', 'schedule', 'k1');
    clock.advance(60_000_000); // 1000 minutes of refill

    // Bucket should now be back to exactly 3 — can grant 3 in a row, deny 4th.
    expect((await limiter.check('pack-a', 'schedule', 'k1')).allowed).toBe(true);
    expect((await limiter.check('pack-a', 'schedule', 'k1')).allowed).toBe(true);
    expect((await limiter.check('pack-a', 'schedule', 'k1')).allowed).toBe(true);
    expect((await limiter.check('pack-a', 'schedule', 'k1')).allowed).toBe(false);
  });
});

describe('RateLimiter — concurrency cap', () => {
  let client: Client;

  beforeEach(() => {
    client = createClient({ url: ':memory:' });
  });
  afterEach(() => {
    client.close();
  });

  it('concurrent: 1 — second simultaneous check denied with concurrent_exceeded', async () => {
    const clock = makeClock(5_000_000);
    const limits = new Map<string, PackRateLimits>([
      ['pack-a', { schedule: { max: 100, per: 'minute', concurrent: 1 } }],
    ]);
    const limiter = new RateLimiter(client, { limits, now: clock.now });

    const first = await limiter.check('pack-a', 'schedule', 'k1');
    expect(first.allowed).toBe(true);

    const second = await limiter.check('pack-a', 'schedule', 'k1');
    expect(second.allowed).toBe(false);
    expect(second.reason).toBe('concurrent_exceeded');
  });

  it('release: frees the concurrent slot; next check allowed', async () => {
    const clock = makeClock(6_000_000);
    const limits = new Map<string, PackRateLimits>([
      ['pack-a', { schedule: { max: 100, per: 'minute', concurrent: 1 } }],
    ]);
    const limiter = new RateLimiter(client, { limits, now: clock.now });

    await limiter.check('pack-a', 'schedule', 'k1');
    expect((await limiter.check('pack-a', 'schedule', 'k1')).allowed).toBe(false);

    await limiter.release('pack-a', 'schedule', 'k1');
    expect((await limiter.check('pack-a', 'schedule', 'k1')).allowed).toBe(true);
  });

  it('release floor: over-releasing never drives the counter negative', async () => {
    const clock = makeClock(7_000_000);
    const limits = new Map<string, PackRateLimits>([
      ['pack-a', { schedule: { max: 100, per: 'minute', concurrent: 2 } }],
    ]);
    const limiter = new RateLimiter(client, { limits, now: clock.now });

    await limiter.check('pack-a', 'schedule', 'k1');
    await limiter.release('pack-a', 'schedule', 'k1');
    await limiter.release('pack-a', 'schedule', 'k1'); // extra release
    await limiter.release('pack-a', 'schedule', 'k1'); // extra release

    // The bucket should now allow 2 concurrent slots again (counter never dropped below 0).
    expect((await limiter.check('pack-a', 'schedule', 'k1')).allowed).toBe(true);
    expect((await limiter.check('pack-a', 'schedule', 'k1')).allowed).toBe(true);
    expect((await limiter.check('pack-a', 'schedule', 'k1')).allowed).toBe(false);
  });

  it('release is a no-op for unconfigured (pack, trigger) pair', async () => {
    const clock = makeClock(8_000_000);
    const limiter = new RateLimiter(client, { limits: new Map(), now: clock.now });
    await expect(limiter.release('no-such-pack', 'schedule', 'k')).resolves.toBeUndefined();
  });
});

describe('RateLimiter — unconfigured default', () => {
  let client: Client;

  beforeEach(() => {
    client = createClient({ url: ':memory:' });
  });
  afterEach(() => {
    client.close();
  });

  it('pack without a rate_limits entry is unlimited (allowed: true, no libsql touch)', async () => {
    const clock = makeClock(9_000_000);
    const limiter = new RateLimiter(client, { limits: new Map(), now: clock.now });

    // Hammer the limiter — never denied.
    for (let i = 0; i < 50; i++) {
      const verdict = await limiter.check('any-pack', 'schedule', 'k');
      expect(verdict.allowed).toBe(true);
    }

    // The rate_limit_buckets table should not exist yet (no init() triggered).
    // We confirm by checking sqlite_master directly — the row count is 0.
    const rs = await client.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='rate_limit_buckets'",
    );
    expect(rs.rows.length).toBe(0);
  });

  it('pack with rate_limits for one trigger leaves OTHER triggers unlimited', async () => {
    const clock = makeClock(10_000_000);
    const limits = new Map<string, PackRateLimits>([
      ['pack-a', { schedule: { max: 1, per: 'minute' } }],
    ]);
    const limiter = new RateLimiter(client, { limits, now: clock.now });

    // schedule is capped at 1/minute.
    expect((await limiter.check('pack-a', 'schedule', 'k')).allowed).toBe(true);
    expect((await limiter.check('pack-a', 'schedule', 'k')).allowed).toBe(false);

    // webhook for the same pack is unlimited — fire 20 in a row.
    for (let i = 0; i < 20; i++) {
      expect((await limiter.check('pack-a', 'webhook', 'k')).allowed).toBe(true);
    }
  });
});

describe('RateLimiter — restart survival', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'opensquid-rl-'));
    dbPath = join(dir, 'rl.db');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('bucket state survives a daemon restart (same dbUrl, fresh Client)', async () => {
    const clock = makeClock(11_000_000);
    const limits = new Map<string, PackRateLimits>([
      ['pack-a', { schedule: { max: 5, per: 'minute' } }],
    ]);

    // First "daemon" instance — drain the bucket to 0.
    const client1 = createClient({ url: `file:${dbPath}` });
    const limiter1 = new RateLimiter(client1, { limits, now: clock.now });
    for (let i = 0; i < 5; i++) {
      expect((await limiter1.check('pack-a', 'schedule', 'k1')).allowed).toBe(true);
    }
    expect((await limiter1.check('pack-a', 'schedule', 'k1')).allowed).toBe(false);
    client1.close();

    // Second "daemon" instance at the SAME tick — bucket should still be 0.
    const client2 = createClient({ url: `file:${dbPath}` });
    const limiter2 = new RateLimiter(client2, { limits, now: clock.now });
    const verdict = await limiter2.check('pack-a', 'schedule', 'k1');
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe('rate_exceeded');
    client2.close();
  });
});

describe('RateLimiter — fail-closed posture', () => {
  it('libsql error during check() → deny + onError invoked', async () => {
    const clock = makeClock(12_000_000);
    const limits = new Map<string, PackRateLimits>([
      ['pack-a', { schedule: { max: 10, per: 'minute' } }],
    ]);

    // Real client to bootstrap init(); then close it so subsequent
    // .execute() calls fail with "client is closed" — that's the libsql
    // failure mode we expect the limiter to fail-CLOSED on.
    const client = createClient({ url: ':memory:' });
    const onError = vi.fn();
    const limiter = new RateLimiter(client, { limits, now: clock.now, onError });

    // Force init() to run successfully against the live client first so we
    // isolate the read/write failure path (not the DDL path).
    expect((await limiter.check('pack-a', 'schedule', 'k')).allowed).toBe(true);

    client.close();

    const verdict = await limiter.check('pack-a', 'schedule', 'k');
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe('rate_limit_storage_error');
    expect(onError).toHaveBeenCalledOnce();
    const call = onError.mock.calls[0]!;
    expect(call[1]).toEqual({ packId: 'pack-a', triggerKind: 'schedule', key: 'k' });
  });

  it('libsql error during release() → onError invoked, no throw', async () => {
    const clock = makeClock(13_000_000);
    const limits = new Map<string, PackRateLimits>([
      ['pack-a', { schedule: { max: 10, per: 'minute', concurrent: 1 } }],
    ]);

    const client = createClient({ url: ':memory:' });
    const onError = vi.fn();
    const limiter = new RateLimiter(client, { limits, now: clock.now, onError });

    // Get a row written.
    await limiter.check('pack-a', 'schedule', 'k');
    client.close();

    await expect(limiter.release('pack-a', 'schedule', 'k')).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
  });
});
