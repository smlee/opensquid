/**
 * Pack-declared rate limits — token-bucket with libsql persistence (AUTO.2).
 *
 * Authoritative source: `docs/tasks/automation.md` AUTO.2.
 *
 * Token-bucket over fixed-window because the trigger sources AUTO.2 feeds
 * (SCHED.1, AUTO.5, AUTO.6, SCHED.2) are bursty — a save firing 50
 * file_changed events in 1s then nothing for an hour should be allowed up
 * to `max` then metered, not denied "for the rest of the window".
 *
 * Math: continuous refill, clamped both sides.
 *   tokens = clamp(tokens + (now - last_refill_ms) * (max / per_ms), 0, max)
 * High clamp prevents float-creep above `max` over many partial refills;
 * low clamp guards against any future clock-skew drift below 0.
 *
 * Atomicity: explicit `BEGIN IMMEDIATE ... COMMIT` on the primary client
 * (not `client.transaction()`, which spins a separate logical connection
 * and starts from an empty `:memory:` db). SQLite's IMMEDIATE lock
 * serialises concurrent `check()`s at the storage layer — works the same
 * across daemon restarts (the survival requirement in the spec).
 *
 * Fail-closed (constraint C10): any libsql error returns `{allowed: false,
 * reason: 'rate_limit_storage_error'}` and invokes the caller's `onError`
 * sink. The limiter never silently allows traffic when storage is broken;
 * the caller routes the error to the user's notification channel.
 *
 * Time-source injection: `now: () => number = Date.now` on the
 * constructor; every test passes a fake clock.
 *
 * Imports from: @libsql/client.
 * Imported by: src/runtime/bootstrap.ts (wired by SCHED.1 + AUTO.6 later).
 */

import type { Client } from '@libsql/client';

import type { TriggerKind } from '../packs/schemas/skill.js';

/**
 * Per-trigger config; matches the `rate_limits:` manifest shape. `max` +
 * `per` required; `concurrent` defaults to no cap.
 */
export interface RateLimitConfig {
  max: number;
  per: 'minute' | 'hour' | 'day';
  concurrent?: number;
}

/**
 * Per-pack config: trigger kind → limit config. Absent key → unlimited
 * (spec: "Unconfigured packs are unlimited").
 */
export type PackRateLimits = Partial<Record<TriggerKind, RateLimitConfig>>;

export interface RateLimitDecision {
  allowed: boolean;
  /** Hint to callers — milliseconds until at least one token will be available. */
  retryAfterMs?: number;
  /**
   * Machine-readable cause when `allowed=false`. One of:
   *   - 'rate_exceeded'         — token bucket empty
   *   - 'concurrent_exceeded'   — concurrent counter at cap
   *   - 'rate_limit_storage_error' — libsql read/write failed (fail-closed)
   */
  reason?: 'rate_exceeded' | 'concurrent_exceeded' | 'rate_limit_storage_error';
}

const PER_TO_MS: Record<RateLimitConfig['per'], number> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
};

interface BucketRow {
  tokens: number;
  last_refill_ms: number;
  concurrent_count: number;
}

export interface RateLimiterOpts {
  /** Per-pack limits; lookup miss → no limiter applied for that key. */
  limits: Map<string, PackRateLimits>;
  /** Injected clock — every test passes a fake `now`. */
  now?: () => number;
  /**
   * Optional storage-error sink. Caller routes to NotificationRouter; the
   * limiter never imports the channel stack directly (engine-vocabulary
   * discipline — speaks in pack/trigger/key only).
   */
  onError?: (err: unknown, ctx: { packId: string; triggerKind: TriggerKind; key: string }) => void;
}

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS rate_limit_buckets (
    pack_id TEXT NOT NULL,
    trigger_kind TEXT NOT NULL,
    key TEXT NOT NULL,
    tokens REAL NOT NULL,
    last_refill_ms INTEGER NOT NULL,
    concurrent_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (pack_id, trigger_kind, key)
  );
`;

export class RateLimiter {
  private readonly limits: Map<string, PackRateLimits>;
  private readonly nowFn: () => number;
  private readonly onError?: RateLimiterOpts['onError'];
  private initialized = false;

  constructor(
    private readonly db: Client,
    opts: RateLimiterOpts,
  ) {
    this.limits = opts.limits;
    this.nowFn = opts.now ?? Date.now;
    this.onError = opts.onError;
  }

  /**
   * Idempotent schema setup — `CREATE TABLE IF NOT EXISTS at first-use`,
   * matching the RAG backends. No versioned migration framework in
   * opensquid yet; idempotent DDL is the locked posture for AUTO.2.
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    await this.db.execute(CREATE_TABLE_SQL);
    this.initialized = true;
  }

  /**
   * Request one slot. Allowed → decrement tokens, increment concurrent,
   * persist atomically. Denied (either cap or libsql error / fail-closed)
   * → `{allowed: false}` with a machine-readable `reason`.
   *
   * Unconfigured (pack, triggerKind) → `{allowed: true}` immediately, no
   * libsql touch (unlimited default per spec).
   */
  async check(packId: string, triggerKind: TriggerKind, key: string): Promise<RateLimitDecision> {
    const config = this.limits.get(packId)?.[triggerKind];
    if (!config) return { allowed: true };

    await this.init();
    const now = this.nowFn();
    const perMs = PER_TO_MS[config.per];
    const refillPerMs = config.max / perMs;
    const concurrentCap = config.concurrent ?? Number.POSITIVE_INFINITY;

    let inTx = false;
    try {
      await this.db.execute('BEGIN IMMEDIATE');
      inTx = true;
      const row = await this.readBucket(packId, triggerKind, key);

      // Refill: continuous, clamped to [0, max].
      const baseTokens = row?.tokens ?? config.max;
      const baseLastRefillMs = row?.last_refill_ms ?? now;
      const elapsed = Math.max(0, now - baseLastRefillMs);
      const refilled = clamp(baseTokens + elapsed * refillPerMs, 0, config.max);
      const concurrent = row?.concurrent_count ?? 0;

      if (concurrent >= concurrentCap) {
        // Persist refill so a later check() after release() sees fresh
        // tokens, but do NOT decrement / increment.
        await this.writeBucket(packId, triggerKind, key, refilled, now, concurrent);
        await this.db.execute('COMMIT');
        inTx = false;
        return {
          allowed: false,
          retryAfterMs: 0, // freed by release(), not by clock
          reason: 'concurrent_exceeded',
        };
      }

      if (refilled < 1) {
        const tokensShort = 1 - refilled;
        const retryAfterMs = Math.ceil(tokensShort / refillPerMs);
        await this.writeBucket(packId, triggerKind, key, refilled, now, concurrent);
        await this.db.execute('COMMIT');
        inTx = false;
        return {
          allowed: false,
          retryAfterMs,
          reason: 'rate_exceeded',
        };
      }

      await this.writeBucket(packId, triggerKind, key, refilled - 1, now, concurrent + 1);
      await this.db.execute('COMMIT');
      inTx = false;
      return { allowed: true };
    } catch (err) {
      if (inTx) {
        try {
          await this.db.execute('ROLLBACK');
        } catch {
          /* ignore */
        }
      }
      this.onError?.(err, { packId, triggerKind, key });
      return { allowed: false, reason: 'rate_limit_storage_error' };
    }
  }

  /**
   * Free the concurrent slot taken by a prior allowed `check()`. Floors at
   * 0 — over-releasing never drives the counter negative. Unconfigured
   * (pack, triggerKind) → no-op. libsql error → invoke `onError` (surface
   * to operator); fail-closed posture lives on `check()`, not `release()`.
   */
  async release(packId: string, triggerKind: TriggerKind, key: string): Promise<void> {
    const config = this.limits.get(packId)?.[triggerKind];
    if (!config) return;

    await this.init();

    let inTx = false;
    try {
      await this.db.execute('BEGIN IMMEDIATE');
      inTx = true;
      const row = await this.readBucket(packId, triggerKind, key);
      if (!row) {
        // No bucket row → nothing to release. Don't manufacture one.
        await this.db.execute('COMMIT');
        inTx = false;
        return;
      }
      const nextConcurrent = Math.max(0, row.concurrent_count - 1);
      // last_refill_ms intentionally NOT advanced — release() is a
      // counter-only operation; advancing would shift the refill window.
      await this.writeBucket(
        packId,
        triggerKind,
        key,
        row.tokens,
        row.last_refill_ms,
        nextConcurrent,
      );
      await this.db.execute('COMMIT');
      inTx = false;
    } catch (err) {
      if (inTx) {
        try {
          await this.db.execute('ROLLBACK');
        } catch {
          /* ignore */
        }
      }
      this.onError?.(err, { packId, triggerKind, key });
    }
  }

  // Storage helpers — private so the only contract is check / release.

  private async readBucket(
    packId: string,
    triggerKind: TriggerKind,
    key: string,
  ): Promise<BucketRow | null> {
    const rs = await this.db.execute({
      sql: `SELECT tokens, last_refill_ms, concurrent_count
            FROM rate_limit_buckets
            WHERE pack_id = ? AND trigger_kind = ? AND key = ?`,
      args: [packId, triggerKind, key],
    });
    const row = rs.rows[0];
    if (!row) return null;
    return {
      tokens: Number(row.tokens),
      last_refill_ms: Number(row.last_refill_ms),
      concurrent_count: Number(row.concurrent_count),
    };
  }

  private async writeBucket(
    packId: string,
    triggerKind: TriggerKind,
    key: string,
    tokens: number,
    lastRefillMs: number,
    concurrent: number,
  ): Promise<void> {
    await this.db.execute({
      sql: `INSERT INTO rate_limit_buckets
              (pack_id, trigger_kind, key, tokens, last_refill_ms, concurrent_count)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (pack_id, trigger_kind, key) DO UPDATE SET
              tokens = excluded.tokens,
              last_refill_ms = excluded.last_refill_ms,
              concurrent_count = excluded.concurrent_count`,
      args: [packId, triggerKind, key, tokens, lastRefillMs, concurrent],
    });
  }
}

function clamp(value: number, lo: number, hi: number): number {
  if (Number.isNaN(value)) return lo;
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}
