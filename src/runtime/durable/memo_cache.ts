/**
 * Memoization cache for primitive outputs (DURABLE.3).
 *
 * Primitives that declare `memoizable: true` (DURABLE.2) cache outputs keyed
 * by `(fn, inputs_hash)`. Identical inputs → cached output, primitive not
 * invoked. The evaluator wraps the cache check around `invokeDurable`'s
 * checkpoint-restore branch: a checkpoint hit (same run, same step) still
 * wins; a memo hit serves cross-run replays of identical-input calls.
 *
 * Two-tier design:
 *
 *   Memory tier (`LRUCache<string, MemoryEntry>`): hot, ~1000 entries cap,
 *   per-entry TTL via the entry's `expiresAtMs`. Sub-millisecond hit; rebuilt
 *   on demand from the persistent tier after a daemon restart.
 *
 *   libsql tier (`memo_cache` table): persistent across daemon restarts.
 *   `idx_memo_cached_at` indexes age for the prune verb. Outputs round-trip
 *   through `canonical_json` so Date/Buffer survive (same envelope rules as
 *   DURABLE.1's checkpoint store).
 *
 * Singleflight (in-flight Promise dedup):
 *
 *   A cache stampede — 100 concurrent calls for the same miss → 100 primitive
 *   invocations — defeats the whole point. `get()` keeps an `inflight` map
 *   keyed by the same `${fn}::${inputsHash}` string. When N callers race on a
 *   miss, the FIRST caller's `set()` writes the entry and clears the inflight
 *   record; the remaining N-1 callers await the same Promise and read from
 *   the cache once it settles. The runtime caller pattern is:
 *
 *     const cached = await cache.get(fn, hash, ttl);
 *     if (cached !== null) return cached.value;
 *     return cache.singleflight(fn, hash, async () => {
 *       const fresh = await invokePrimitive();
 *       await cache.set(fn, hash, fresh, ttl);
 *       return fresh;
 *     });
 *
 *   That keeps singleflight orthogonal to the cache lookup: a clean caller
 *   can opt out (e.g. tests verifying miss-path semantics) by skipping
 *   `singleflight()` and calling the primitive directly.
 *
 * TTL policy:
 *
 *   Caller provides a `ttlMs?: number` to both `get()` and `set()`. When
 *   omitted, the entry has NO TTL (lives until evicted by LRU or cleared by
 *   `clear({fn,olderThanMs})`). The runtime wrap (evaluator) uses the
 *   per-primitive class defaults below; the cache itself is policy-free.
 *
 *     LLM (llm_classify):        3_600_000  ( 1h)
 *     RAG (recall, embed):         300_000  ( 5m)
 *     http_request:                 30_000  (30s)
 *     check_destination:          3_600_000  ( 1h)
 *
 *   These match the spec's risk-callout for stale outputs in state-sensitive
 *   primitives and are tuned to be conservative (RAG indexes change often;
 *   HTTP responses are the most volatile; LLM classifications on the same
 *   prompt+model+temperature are stable enough for an hour).
 *
 * Privacy / PII:
 *
 *   Cached prompts MAY contain PII — `llm_classify` args carry whatever the
 *   pack passes in, which can include user emails, file contents, names.
 *   Two mitigations:
 *
 *     1. The persistent tier stores `outputs_json` AND `inputs_hash` (the
 *        hash of inputs, not the raw inputs themselves). Inputs are never
 *        persisted in this module. The hash is sha256, non-reversible.
 *
 *     2. Pack authors who handle sensitive payloads should set
 *        `cached_at_ms TTL ≤ pack sensitivity threshold` — the cache
 *        enforces TTL, the pack chooses the threshold. The pack-declared
 *        sensitivity threshold work lives in a later track (privacy.md is
 *        not in scope for DURABLE.3); until then, callers pass conservative
 *        TTLs and rely on `clear()` for explicit purges.
 *
 * Imports from: @libsql/client, lru-cache, ./canonical_json.js.
 * Imported by: evaluator (DURABLE.3 wrap), future `opensquid cache` CLI.
 */

import type { Client } from '@libsql/client';
import { LRUCache } from 'lru-cache';

import { canonicalJsonParse, canonicalJsonStringify } from './canonical_json.js';

// ---------------------------------------------------------------------------
// MemoryEntry — value held in the in-memory LRU tier.
//
// We pair the parsed `value` with an `expiresAtMs` snapshot so each entry
// carries its own TTL. The LRU's per-entry TTL feature would also work, but
// we want the same expiry semantics in both tiers — keeping the deadline on
// the value lets the libsql tier reuse the exact same `isExpired` check.
// ---------------------------------------------------------------------------

interface MemoryEntry {
  value: unknown;
  /** Unix ms after which this entry must be treated as expired. `null` = no TTL. */
  expiresAtMs: number | null;
}

// ---------------------------------------------------------------------------
// MemoStats — one row per primitive surfaced by `stats()`.
//
// `hits` is summed across all rows for the primitive in the persistent tier
// (since restart). `size` is the count of live (non-expired) rows. The
// memory tier deliberately does NOT contribute to these counts — a daemon
// restart would otherwise reset reported hit counts to zero and trip the
// CLI's "is this thing working" check.
// ---------------------------------------------------------------------------

export interface MemoStats {
  fn: string;
  hits: number;
  size: number;
}

// ---------------------------------------------------------------------------
// Schema — `memo_cache` table + `idx_memo_cached_at` index.
//
// `CREATE TABLE IF NOT EXISTS` matches the AUTO.2 RateLimiter migration
// pattern: idempotent DDL, applied at first call to `init()`. No versioned
// migration framework in opensquid yet.
//
// `outputs_json TEXT NOT NULL` — `canonical_json` produces a deterministic
// string; we never store NULL outputs (a primitive that succeeded with
// `null` serializes to the JSON string `'null'`, which is fine).
//
// `ttl_ms INTEGER` is nullable: NULL means "no TTL, lives until clear()".
// ---------------------------------------------------------------------------

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS memo_cache (
    fn TEXT NOT NULL,
    inputs_hash TEXT NOT NULL,
    outputs_json TEXT NOT NULL,
    cached_at_ms INTEGER NOT NULL,
    ttl_ms INTEGER,
    hit_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (fn, inputs_hash)
  );
`;

const CREATE_INDEX_CACHED_AT_SQL = `
  CREATE INDEX IF NOT EXISTS idx_memo_cached_at ON memo_cache(cached_at_ms);
`;

// ---------------------------------------------------------------------------
// Options for MemoCache construction. `memoryMax` matches the spec's 1000
// default; tests override it to exercise eviction without writing 1k rows.
// `nowMs` is the injected clock — production passes `Date.now`.
// ---------------------------------------------------------------------------

export interface MemoCacheOpts {
  /** Max entries in the memory tier. Default 1000. */
  memoryMax?: number;
  /** Injected clock; defaults to `Date.now`. */
  nowMs?: () => number;
}

export class MemoCache {
  private readonly memory: LRUCache<string, MemoryEntry>;
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly nowMs: () => number;
  private initialized = false;

  constructor(
    private readonly db: Client,
    opts: MemoCacheOpts = {},
  ) {
    this.memory = new LRUCache<string, MemoryEntry>({
      max: opts.memoryMax ?? 1000,
    });
    this.nowMs = opts.nowMs ?? Date.now;
  }

  /**
   * Idempotent DDL. Safe to call repeatedly; only the first call hits
   * libsql. Same posture as `CheckpointStore.init` and `RateLimiter.init`.
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    await this.db.execute(CREATE_TABLE_SQL);
    await this.db.execute(CREATE_INDEX_CACHED_AT_SQL);
    this.initialized = true;
  }

  /**
   * Two-tier lookup.
   *
   *   1. Memory hit + not expired → return value.
   *   2. Memory miss → libsql lookup.
   *   3. Libsql hit + not expired → bump hit_count, restore to memory tier,
   *      return value.
   *   4. Otherwise → null (miss).
   *
   * `ttlMs` is the CALLER's TTL contract. When the persistent row has its
   * OWN `ttl_ms` set, that value is authoritative — the row's TTL was the
   * one in effect at `set()` time, and re-interpreting it under a different
   * TTL at read time would silently extend or shrink the entry's lifetime.
   * The `ttlMs` parameter on `get()` is only used when the row has a NULL
   * `ttl_ms` AND the caller wants to retroactively bound an indefinite
   * entry (rare; supplied for symmetry with `set()`).
   *
   * Returns the cached value (which may be `null`-as-cached-output — the
   * spec stores the primitive's return value verbatim, so a primitive that
   * legitimately returned `null` would store `null`; we wrap the hit/miss
   * signal in the return type's nullability convention by distinguishing
   * `null` (miss) from a wrapped value (hit).
   *
   * Convention: callers should check `=== null` for miss. A primitive that
   * really returned `null` ends up encoded as the JSON `null` string in the
   * persistent tier, and on read we return a wrapper to disambiguate — see
   * the `MemoHit` type below.
   */
  async get(fn: string, inputsHash: string, ttlMs?: number): Promise<MemoHit | null> {
    const key = cacheKey(fn, inputsHash);
    const now = this.nowMs();

    // 1. Memory tier.
    const mem = this.memory.get(key);
    if (mem !== undefined) {
      if (mem.expiresAtMs === null || mem.expiresAtMs > now) {
        return { value: mem.value };
      }
      // Stale memory entry — drop it; fall through to libsql in case the
      // persistent tier has been refreshed by another process.
      this.memory.delete(key);
    }

    // 2. libsql tier.
    await this.init();
    const rs = await this.db.execute({
      sql: `SELECT outputs_json, cached_at_ms, ttl_ms
            FROM memo_cache
            WHERE fn = ? AND inputs_hash = ?`,
      args: [fn, inputsHash],
    });
    const row = rs.rows[0];
    if (!row) return null;

    const cachedAtMs = Number(row.cached_at_ms);
    const rowTtlRaw = row.ttl_ms;
    const rowTtlMs = rowTtlRaw === null || rowTtlRaw === undefined ? null : Number(rowTtlRaw);
    // When the row has its own TTL, that's authoritative. Otherwise fall
    // back to the caller's optional `ttlMs`.
    const effectiveTtlMs = rowTtlMs ?? ttlMs ?? null;
    const expiresAtMs = effectiveTtlMs === null ? null : cachedAtMs + effectiveTtlMs;

    if (expiresAtMs !== null && expiresAtMs <= now) {
      // Expired in libsql tier — delete it so we don't carry a tombstone.
      await this.db.execute({
        sql: `DELETE FROM memo_cache WHERE fn = ? AND inputs_hash = ?`,
        args: [fn, inputsHash],
      });
      return null;
    }

    // 3. Libsql hit — bump hit_count + restore memory. libsql columns can
    // round-trip as `string | number | ArrayBuffer | bigint | null`; the
    // `TEXT NOT NULL` constraint pins this one to string but the driver's
    // type union is wider, so we narrow explicitly rather than coerce.
    const outputsJsonRaw = row.outputs_json;
    if (typeof outputsJsonRaw !== 'string') return null;
    const value = canonicalJsonParse(outputsJsonRaw);
    await this.db.execute({
      sql: `UPDATE memo_cache SET hit_count = hit_count + 1
            WHERE fn = ? AND inputs_hash = ?`,
      args: [fn, inputsHash],
    });
    this.memory.set(key, { value, expiresAtMs });
    return { value };
  }

  /**
   * Write both tiers. Memory first (cheap, in-process), then libsql (the
   * source of truth across restarts). `INSERT OR REPLACE` keeps the write
   * idempotent: the same `(fn, inputs_hash)` written twice in a row
   * preserves the latest output and resets `cached_at_ms` to the new write
   * time. `hit_count` is reset to 0 because the entry is logically new.
   *
   * When `ttlMs` is omitted (or explicitly `undefined`), the persistent row
   * stores `NULL` — no expiry; the entry lives until evicted by LRU
   * pressure or removed by `clear()`.
   */
  async set(fn: string, inputsHash: string, outputs: unknown, ttlMs?: number): Promise<void> {
    await this.init();
    const key = cacheKey(fn, inputsHash);
    const now = this.nowMs();
    const expiresAtMs = ttlMs === undefined ? null : now + ttlMs;
    this.memory.set(key, { value: outputs, expiresAtMs });

    const outputsJson = canonicalJsonStringify(outputs);
    await this.db.execute({
      sql: `INSERT OR REPLACE INTO memo_cache
              (fn, inputs_hash, outputs_json, cached_at_ms, ttl_ms, hit_count)
            VALUES (?, ?, ?, ?, ?, 0)`,
      args: [fn, inputsHash, outputsJson, now, ttlMs ?? null],
    });
  }

  /**
   * Singleflight: dedup concurrent misses on the same key. The first caller
   * runs `compute()`; subsequent callers await the same Promise. The
   * inflight record is removed in `finally` so a failure on the first
   * caller doesn't poison the key forever.
   *
   * Important: this method does NOT itself cache the result — `compute()`
   * is expected to call `set()` after the primitive returns. The wrap
   * pattern is documented in the file header.
   *
   * Returning `unknown` keeps the API substrate-shaped: the runtime caller
   * casts to the primitive's return type once the FunctionRegistry has
   * confirmed args + output handling.
   */
  async singleflight<T>(fn: string, inputsHash: string, compute: () => Promise<T>): Promise<T> {
    const key = cacheKey(fn, inputsHash);
    const existing = this.inflight.get(key);
    if (existing) {
      return existing as Promise<T>;
    }
    const p = compute().finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, p);
    return p;
  }

  /**
   * Invalidate cache entries. Both tiers honored.
   *
   *   - `{}`                       → wipe everything.
   *   - `{ fn: 'llm_classify' }`   → wipe all llm_classify entries.
   *   - `{ olderThanMs: 7 * 86_400_000 }` → wipe entries cached more than
   *      7 days ago.
   *   - `{ fn, olderThanMs }`      → AND of both predicates.
   *
   * Returns the number of persistent-tier rows removed. The memory tier's
   * affected-count is not surfaced (the LRU might have already evicted the
   * row, in which case "removed" is undefined; callers care about durable
   * cleanup).
   */
  async clear(opts: { fn?: string; olderThanMs?: number } = {}): Promise<number> {
    await this.init();

    // Memory tier — scan once. The LRU has no native predicate filter, so
    // we collect candidate keys and delete by key.
    const now = this.nowMs();
    const memCutoff = opts.olderThanMs !== undefined ? now - opts.olderThanMs : null;
    if (opts.fn !== undefined || memCutoff !== null) {
      const toDelete: string[] = [];
      for (const [k] of this.memory.entries()) {
        const fnFromKey = parseCacheKey(k)?.fn;
        if (opts.fn !== undefined && fnFromKey !== opts.fn) continue;
        // Memory-tier rows don't carry a cached_at_ms separately — but
        // expiresAtMs encodes the upper bound. For olderThanMs filtering
        // we can only purge memory by fn; the cached_at_ms cutoff applies
        // strictly to the libsql tier where the field is persisted. This
        // is intentional — memory entries are ephemeral by definition.
        toDelete.push(k);
      }
      for (const k of toDelete) this.memory.delete(k);
    } else {
      this.memory.clear();
    }

    // libsql tier — build a parameterized DELETE.
    const wheres: string[] = [];
    const args: unknown[] = [];
    if (opts.fn !== undefined) {
      wheres.push('fn = ?');
      args.push(opts.fn);
    }
    if (opts.olderThanMs !== undefined) {
      wheres.push('cached_at_ms < ?');
      args.push(now - opts.olderThanMs);
    }
    const where = wheres.length > 0 ? ` WHERE ${wheres.join(' AND ')}` : '';
    const rs = await this.db.execute({
      sql: `DELETE FROM memo_cache${where}`,
      args: args as never,
    });
    return Number(rs.rowsAffected);
  }

  /**
   * Per-primitive stats: hit_count totals + live row counts. Powers the
   * future `opensquid cache stats` CLI verb.
   *
   * Expired rows are excluded from `size` — the count reflects rows that
   * would actually serve traffic today. The persistent table is NOT
   * compacted as a side effect of this call; the GC verb is `clear()` with
   * an `olderThanMs` argument.
   */
  async stats(): Promise<MemoStats[]> {
    await this.init();
    const now = this.nowMs();
    const rs = await this.db.execute({
      sql: `SELECT
              fn,
              SUM(hit_count) AS hits,
              SUM(
                CASE WHEN ttl_ms IS NULL OR cached_at_ms + ttl_ms > ?
                     THEN 1 ELSE 0 END
              ) AS size
            FROM memo_cache
            GROUP BY fn
            ORDER BY fn ASC`,
      args: [now],
    });
    return rs.rows.map((row) => ({
      fn: typeof row.fn === 'string' ? row.fn : '',
      hits: Number(row.hits ?? 0),
      size: Number(row.size ?? 0),
    }));
  }
}

/**
 * Hit envelope. Distinguishes a real cached `null` (a primitive that
 * returned null and stored it) from a miss (`get` returns `null` itself).
 */
export interface MemoHit {
  value: unknown;
}

function cacheKey(fn: string, inputsHash: string): string {
  return `${fn}::${inputsHash}`;
}

function parseCacheKey(key: string): { fn: string; inputsHash: string } | null {
  const idx = key.indexOf('::');
  if (idx < 0) return null;
  return { fn: key.slice(0, idx), inputsHash: key.slice(idx + 2) };
}
