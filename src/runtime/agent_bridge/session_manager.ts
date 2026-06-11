/**
 * agent_bridge — warm-pool session manager (WAB.3, 0.5.95).
 *
 * Authoritative spec: the warm-agent planning notes [not retained — see docs/tasks/WAB.1-architecture.md, which is] WAB.3.
 * Architecture: `docs/tasks/WAB.1-architecture.md` decisions (b) + (c) +
 * Section 2 module layout (≤350 LOC budget for this file).
 *
 * Responsibility:
 *   1. Maintain an LRU of `SessionState` objects keyed by canonical session
 *      slug — Hermes-derived caps (`max=128`, `ttl=3_600_000ms`, verified
 *      against `gateway/run.py:55-65`).
 *   2. Lazy-construct a `SessionState` on first `getOrCreate`, hydrating
 *      `history` from persisted JSONL (WAB.3 `SessionPersistence`).
 *   3. On eviction (LRU cap hit, idle TTL expire, or shutdown), notify the
 *      caller via the optional `onEvict` callback so any unfinished work
 *      (e.g. a final flush) can be performed before the entry vanishes.
 *      The state's `history` is already on disk — eviction is a memory
 *      release, not a data loss.
 *   4. `appendTurn` is the only mutation API — it APPEND-WRITES the new
 *      entries to disk FIRST, then mutates the in-memory `history`, so a
 *      persistence failure leaves the in-memory state cleanly unchanged
 *      (the caller's catch can decide to retry or escalate).
 *
 * Non-responsibility (per WAB.1 (c)):
 *   - Does NOT store an Anthropic SDK client per session. One daemon-wide
 *     client is shared.
 *   - Does NOT compute cache-control breakpoints. Those are derived from
 *     `history` positions at request-time by the agent loop (WAB.4).
 *   - Does NOT serialize concurrent appends to the same session. This is
 *     intentional: the manager is the unsynchronized data plane; the
 *     control plane (`ChatDispatcher` in `dispatcher.ts`) owns the
 *     per-session mutex+queue policy and is the sole production caller of
 *     `appendTurn` (regression-locked by `appendturn_sole_caller.test.ts`).
 *     See the `Concurrency contract:` paragraph on `appendTurn` below for
 *     the policy details.
 *
 * Imports from: lru-cache, ./session_persistence.js, ./types.js.
 * Imported by: (future) dispatcher.ts, daemon.ts.
 */

import { LRUCache } from 'lru-cache';

import { type SessionPersistence } from './session_persistence.js';
import {
  type ChatHistoryEntry,
  type SessionKey,
  type SessionState,
  sessionKeyString,
} from './types.js';

// ---------------------------------------------------------------------------
// Constants — Hermes-derived (gateway/run.py:55-65).
// ---------------------------------------------------------------------------

/** Max warm sessions in memory. Hermes `_AGENT_CACHE_MAX_SIZE`. */
export const AGENT_CACHE_MAX_SIZE = 128;

/** Idle TTL after which an untouched session is evicted. Hermes
 *  `_AGENT_CACHE_IDLE_TTL_SECS = 3600.0` → 3_600_000 ms. */
export const AGENT_CACHE_IDLE_TTL_MS = 3_600_000;

// ---------------------------------------------------------------------------
// Eviction reason — narrowed to the cases the warm-agent cares about.
//
// lru-cache v11's `DisposeReason` includes `'evict' | 'set' | 'delete' |
// 'expire' | 'fetch'`. We collapse them:
//   - 'evict'   → 'lru'      (cap overflow)
//   - 'expire'  → 'idle'     (TTL expiry)
//   - 'set'     → ignored    (we never overwrite via set; same-key set
//                             would also fire 'set' with the OLD value —
//                             not a real eviction we want to surface)
//   - 'delete'  → 'shutdown' (the only `cache.delete` paths are explicit
//                             admin/shutdown drains in this manager)
//   - 'fetch'   → ignored    (we don't use `LRUCache.fetch`)
// `'shutdown'` is also emitted explicitly during `shutdown()` for every
// remaining entry — that's a separate code path from the dispose hook,
// so the consumer sees one onEvict per session regardless.
// ---------------------------------------------------------------------------

export type EvictionReason = 'lru' | 'idle' | 'shutdown';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface SessionManagerOptions {
  persistence: SessionPersistence;
  /** Fallback pack id stamped onto newly-created `SessionState`s when the
   *  caller does not override it. WAB.6 will replace this with a per-call
   *  override (different sessions can run different packs). */
  defaultPackId: string;
  /** Fallback resolved model id stamped onto newly-created states. */
  defaultModelAlias: string;
  /** Override cache cap (tests). Defaults to `AGENT_CACHE_MAX_SIZE`. */
  maxSessions?: number;
  /** Override idle TTL ms (tests). Defaults to `AGENT_CACHE_IDLE_TTL_MS`. */
  idleTtlMs?: number;
  /** Injected clock (tests). Defaults to `Date.now`. */
  nowMs?: () => number;
  /**
   * Fired when a session leaves the cache. Synchronous-return; the
   * implementation may kick an async flush — the SessionManager does not
   * await it (lru-cache's dispose is sync). Callers that need a barrier
   * should track outstanding flushes themselves.
   *
   * For 'lru' / 'idle' reasons: invoked from the LRU dispose hook.
   * For 'shutdown' reason: invoked from `shutdown()` for each remaining
   * entry before the cache is cleared.
   */
  onEvict?: (state: SessionState, reason: EvictionReason) => void;
}

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

export class SessionManager {
  private readonly cache: LRUCache<string, SessionState>;
  private readonly persistence: SessionPersistence;
  private readonly defaultPackId: string;
  private readonly defaultModelAlias: string;
  private readonly nowMs: () => number;
  private readonly onEvict: ((state: SessionState, reason: EvictionReason) => void) | undefined;
  private shutdownInProgress = false;

  constructor(opts: SessionManagerOptions) {
    this.persistence = opts.persistence;
    this.defaultPackId = opts.defaultPackId;
    this.defaultModelAlias = opts.defaultModelAlias;
    this.nowMs = opts.nowMs ?? Date.now;
    this.onEvict = opts.onEvict;

    this.cache = new LRUCache<string, SessionState>({
      max: opts.maxSessions ?? AGENT_CACHE_MAX_SIZE,
      ttl: opts.idleTtlMs ?? AGENT_CACHE_IDLE_TTL_MS,
      // updateAgeOnGet: every cache hit (in `getOrCreate`) resets the TTL
      // countdown. Matches Hermes's "idle ≥ 1h → evict" semantics.
      updateAgeOnGet: true,
      // ttlAutopurge: actively evict expired entries on the timer wheel
      // rather than only on next access. Without this, an idle session
      // would sit in memory until the next `getOrCreate` for that key
      // (which might never come) — defeats the eviction policy.
      ttlAutopurge: true,
      dispose: (value, _key, reason) => {
        // Skip the explicit-shutdown drain path here; we already invoke
        // onEvict('shutdown') from `shutdown()` before clearing.
        if (this.shutdownInProgress) return;
        const mapped = mapDisposeReason(reason);
        if (mapped === null) return;
        try {
          this.onEvict?.(value, mapped);
        } catch {
          // dispose is a sync hook; throwing here corrupts lru-cache's
          // internal state per its docs. Swallow + rely on the consumer
          // to instrument its own onEvict body with try/catch.
        }
      },
    });
  }

  /**
   * Look up an existing warm session, or create one (hydrating its
   * `history` from persisted JSONL). Cache-hit path is a single LRU
   * lookup + sync return inside an awaited promise — no extra I/O.
   *
   * `projectUuid` is required (sessions are project-scoped); pack id +
   * model alias use the manager-level defaults at creation time. WAB.6
   * will add per-call overrides.
   */
  async getOrCreate(key: SessionKey, projectUuid: string): Promise<SessionState> {
    const slug = sessionKeyString(key);
    const existing = this.cache.get(slug);
    if (existing !== undefined) {
      // updateAgeOnGet handled the TTL; refresh lastActivityMs too so
      // telemetry stays consistent with cache age.
      existing.lastActivityMs = this.nowMs();
      return existing;
    }
    const history = await this.persistence.loadHistory(slug);
    const state: SessionState = {
      key,
      history,
      lastActivityMs: this.nowMs(),
      projectUuid,
      packId: this.defaultPackId,
      modelAlias: this.defaultModelAlias,
      turnInFlight: false,
    };
    this.cache.set(slug, state);
    return state;
  }

  /**
   * Append entries from a completed turn. Persistence happens BEFORE
   * in-memory mutation so a write failure leaves the state untouched
   * (the caller can catch and decide).
   *
   * If the session was evicted between turn-start and turn-completion
   * (race against LRU cap or idle TTL), the method is a no-op — there is
   * no warm state to update, and re-creating it just to attach orphan
   * entries would corrupt the order on disk (the evicted state's flush
   * already covers it).
   *
   * Concurrency contract: this method ASSUMES the caller has serialized
   * concurrent calls for the same session. The control plane —
   * `ChatDispatcher.handleFlush` + `runTurnChain` in `dispatcher.ts` —
   * enforces this via a per-session `inFlight` map (depth 1) plus a
   * `pendingQueue` map (depth 1, coalesce up to MAX_QUEUE_COALESCE_ATTEMPTS,
   * then DROP + warn). Adding a SECOND production caller would violate
   * the contract; the `appendturn_sole_caller.test.ts` regression net
   * catches that drift.
   */
  async appendTurn(key: SessionKey, entries: ChatHistoryEntry[]): Promise<void> {
    const slug = sessionKeyString(key);
    const state = this.cache.get(slug);
    if (state === undefined) return;
    // Persist first → if this throws, state is untouched + caller catches.
    await this.persistence.appendEntries(slug, entries);
    state.history.push(...entries);
    state.lastActivityMs = this.nowMs();
    state.turnInFlight = false;
  }

  /**
   * Mark a session's turn as in-flight. Pure in-memory; intended for the
   * batch coordinator (WAB.5) to set BEFORE issuing the agent turn so
   * other inbound batches buffer.
   */
  beginTurn(key: SessionKey): void {
    const state = this.cache.get(sessionKeyString(key));
    if (state !== undefined) state.turnInFlight = true;
  }

  /** Test/admin: returns the live entry without resetting age. */
  peek(key: SessionKey): SessionState | undefined {
    return this.cache.peek(sessionKeyString(key));
  }

  /** Live entry count — for telemetry + tests. */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Drain the cache: emit `onEvict(state, 'shutdown')` for each live
   * session, then clear. Idempotent. After shutdown, the manager is
   * single-use — re-using it would silently start a fresh cache; we
   * surface that as a recoverable no-op rather than throw (matches
   * `InboxTransportBridge.shutdown` semantics).
   */
  shutdown(): void {
    if (this.shutdownInProgress) return;
    this.shutdownInProgress = true;
    // Snapshot entries to a local array — `cache.entries()` is a live
    // iterator and `cache.clear()` invalidates it mid-loop.
    const snapshot: SessionState[] = [];
    for (const [, state] of this.cache.entries()) snapshot.push(state);
    for (const state of snapshot) {
      try {
        this.onEvict?.(state, 'shutdown');
      } catch {
        /* see dispose-hook rationale above */
      }
    }
    this.cache.clear();
  }
}

// ---------------------------------------------------------------------------
// Reason mapping
// ---------------------------------------------------------------------------

function mapDisposeReason(reason: LRUCache.DisposeReason): EvictionReason | null {
  switch (reason) {
    case 'evict':
      return 'lru';
    case 'expire':
      return 'idle';
    case 'delete':
      // `cache.delete` is only called from shutdown drain (handled
      // separately) — but if a future caller invokes it directly, label
      // as 'shutdown' (the closest semantic match: the entry is gone
      // because someone explicitly removed it).
      return 'shutdown';
    case 'set':
    case 'fetch':
    default:
      return null;
  }
}
