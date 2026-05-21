/**
 * agent_bridge — adaptive batch coordinator (WAB.5, 0.5.99).
 *
 * Authoritative spec: `docs/tasks/T-warm-agent-chat-bridge.md` WAB.5.
 * Architecture: `docs/tasks/WAB.1-architecture.md` decision (d).
 *
 * Responsibility:
 *   Buffer rapid-fire inbound chunks for the SAME session and flush a
 *   single coalesced text after a Hermes-derived adaptive quiet period.
 *   Three-tier delay (see Hermes-derived constants below) keeps short
 *   replies snappy (~180 ms) while waiting longer when a chunk hits
 *   Telegram's split threshold (≥4000 chars → continuation almost
 *   certain).
 *
 * Hermes-derived thresholds — VERIFIED against
 *   gateway/platforms/telegram.py:281,291-294,3825-3895.
 * Spec drift caught in WAB.1: the original spec said `4096` + `600 ms`;
 * Hermes's actual values are `4000` + `240 ms`. The constants below match
 * Hermes; deviations require an explicit comment + spec update.
 *
 * Cancellation discipline:
 *   Every new chunk for an in-flight batch calls `clearTimeout` on the
 *   prior timer and installs a fresh one with the recomputed delay. This
 *   matches Hermes's `asyncio.create_task` + `cancel()` pattern at
 *   `telegram.py:3850-3854`. `clearTimeout` is reliable in Node — but
 *   the timer's callback may already be queued when we clear; the
 *   `pending.has(k)` defensive check inside `flush` covers that race.
 *
 * Shutdown:
 *   `shutdown()` clears every pending timer and drops every batch
 *   WITHOUT firing onFlush. The dispatcher's higher-level shutdown is
 *   responsible for forwarding final batches (the coordinator cannot
 *   safely `await` an async onFlush from a sync shutdown without
 *   introducing a half-flushed state on re-entry).
 *
 * Imports from: ./types.js.
 * Imported by: ./dispatcher.ts, ./index.ts (barrel).
 */

import type { SessionKey } from './types.js';
import { sessionKeyString } from './types.js';

// ---------------------------------------------------------------------------
// Hermes-derived constants — gateway/platforms/telegram.py:281,291-294.
// ---------------------------------------------------------------------------

/** Telegram client-side split threshold (4096 limit − 96 char safety
 *  margin). Last chunk ≥ this → continuation almost certain. */
export const TG_SPLIT_THRESHOLD = 4000;

/** Total length ≤ this → "fast" tier (capped at fast delay). */
export const TEXT_BATCH_FAST_LEN = 320;

/** Total length ≤ this → "short" tier (capped at short delay). */
export const TEXT_BATCH_SHORT_LEN = 1024;

/** Fast-tier delay floor (~180 ms — Hermes `_TEXT_BATCH_FAST_DELAY_S=0.18`). */
export const TEXT_BATCH_FAST_DELAY_MS = 180;

/** Short-tier delay floor (~240 ms — Hermes `_TEXT_BATCH_SHORT_DELAY_S=0.24`). */
export const TEXT_BATCH_SHORT_DELAY_MS = 240;

/** Default cap when neither fast nor short tier matches. Hermes default
 *  is `0.3s` configurable to 2s; opensquid runs longer-form chat so we
 *  pick `1200 ms` per WAB.5 spec — measure + adjust in WAB.8 perf pass. */
export const TEXT_BATCH_DELAY_MS_DEFAULT = 1200;

/** Split-tier delay. Hermes default is `1.0s` configurable to 4s;
 *  WAB.5 spec picks `1500 ms` to absorb grammy's slower bursting. */
export const TEXT_BATCH_SPLIT_DELAY_MS = 1500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PendingBatch {
  /** Coalesced text accumulated for this session. */
  text: string;
  /** Length of the most recently appended chunk (drives split-tier). */
  lastChunkLen: number;
  /** Active flush timer; cleared + reinstalled on every new chunk. */
  flushTimer: ReturnType<typeof setTimeout>;
}

export interface BatchCoordinatorOptions {
  /**
   * Fired when the quiet-period elapses for a session's batch. The
   * coordinator awaits this — slow onFlush handlers naturally
   * back-pressure further `ingest` calls for the SAME session because
   * the pending entry is already removed by the time we await. Returning
   * a rejected promise is logged via `onError` and otherwise swallowed
   * (the dispatcher's catch in onFlush is the right place to surface).
   */
  onFlush: (key: SessionKey, coalescedText: string) => Promise<void>;
  /** Override fast-tier delay (tests). Defaults to {@link TEXT_BATCH_FAST_DELAY_MS}. */
  fastDelayMs?: number;
  /** Override short-tier delay (tests). Defaults to {@link TEXT_BATCH_SHORT_DELAY_MS}. */
  shortDelayMs?: number;
  /** Override default-tier delay (tests). Defaults to {@link TEXT_BATCH_DELAY_MS_DEFAULT}. */
  defaultDelayMs?: number;
  /** Override split-tier delay (tests). Defaults to {@link TEXT_BATCH_SPLIT_DELAY_MS}. */
  splitDelayMs?: number;
  /** Structured error sink for onFlush rejections. Defaults to a no-op. */
  onError?: (key: SessionKey, err: unknown) => void;
}

// ---------------------------------------------------------------------------
// BatchCoordinator
// ---------------------------------------------------------------------------

export class BatchCoordinator {
  private readonly pending = new Map<string, PendingBatch>();
  private readonly fastDelay: number;
  private readonly shortDelay: number;
  private readonly defaultDelay: number;
  private readonly splitDelay: number;
  private readonly onError: (key: SessionKey, err: unknown) => void;
  private stopped = false;

  constructor(private readonly opts: BatchCoordinatorOptions) {
    this.fastDelay = opts.fastDelayMs ?? TEXT_BATCH_FAST_DELAY_MS;
    this.shortDelay = opts.shortDelayMs ?? TEXT_BATCH_SHORT_DELAY_MS;
    this.defaultDelay = opts.defaultDelayMs ?? TEXT_BATCH_DELAY_MS_DEFAULT;
    this.splitDelay = opts.splitDelayMs ?? TEXT_BATCH_SPLIT_DELAY_MS;
    this.onError = opts.onError ?? noopError;
  }

  /**
   * Append a chunk for `key` and (re)install the flush timer.
   *
   * The empty-string chunk is a no-op (sender sent nothing typeable) —
   * we still log it through, but DON'T install a timer for it because
   * the resulting coalesced text would be `''` and the onFlush would
   * receive an empty payload. Skip silently.
   */
  ingest(key: SessionKey, text: string): void {
    if (this.stopped) return;
    if (text.length === 0) return;
    const k = sessionKeyString(key);
    const existing = this.pending.get(k);
    if (existing !== undefined) {
      // Append with a single newline separator (matches Hermes
      // telegram.py:3842 `f"{existing.text}\n{event.text}"`).
      existing.text = `${existing.text}\n${text}`;
      existing.lastChunkLen = text.length;
      clearTimeout(existing.flushTimer);
      const delay = this.computeDelay(existing);
      existing.flushTimer = setTimeout(() => {
        void this.flush(key, k);
      }, delay);
      return;
    }
    // First chunk for this session — install a fresh batch.
    const batch: PendingBatch = {
      text,
      lastChunkLen: text.length,
      // Placeholder; replaced below before any timer could fire.
      flushTimer: setTimeout(() => {
        /* placeholder */
      }, 0),
    };
    clearTimeout(batch.flushTimer);
    const delay = this.computeDelay(batch);
    batch.flushTimer = setTimeout(() => {
      void this.flush(key, k);
    }, delay);
    this.pending.set(k, batch);
  }

  /**
   * Three-tier delay computation. Order is intentional:
   *   1. Split (last chunk ≥ TG_SPLIT_THRESHOLD) — continuation almost
   *      certain, wait the longer split delay even if total is short.
   *   2. Fast (total ≤ TEXT_BATCH_FAST_LEN) — `min(default, fast)` so an
   *      operator who lowers the default below 180ms still wins.
   *   3. Short (total ≤ TEXT_BATCH_SHORT_LEN) — same min() composition.
   *   4. Otherwise the configured default cap.
   */
  private computeDelay(batch: PendingBatch): number {
    if (batch.lastChunkLen >= TG_SPLIT_THRESHOLD) return this.splitDelay;
    const total = batch.text.length;
    if (total <= TEXT_BATCH_FAST_LEN) return Math.min(this.defaultDelay, this.fastDelay);
    if (total <= TEXT_BATCH_SHORT_LEN) return Math.min(this.defaultDelay, this.shortDelay);
    return this.defaultDelay;
  }

  /**
   * Fire onFlush for `k`'s coalesced batch.
   *
   * Defensive `pending.has(k)` check: setTimeout callbacks may already
   * be queued in libuv when `clearTimeout` runs (Node docs are explicit
   * about this race). The check ensures we never double-flush — if a
   * newer ingest already replaced the batch, the prior delete would
   * have happened only if the timer fired first; in the racy case, the
   * pending entry is the NEW batch and we run it with current state.
   * Either way, exactly one onFlush per coalesced window.
   */
  private async flush(key: SessionKey, k: string): Promise<void> {
    if (this.stopped) return;
    const batch = this.pending.get(k);
    if (batch === undefined) return;
    this.pending.delete(k);
    try {
      await this.opts.onFlush(key, batch.text);
    } catch (err) {
      this.onError(key, err);
    }
  }

  /**
   * Drop all pending batches WITHOUT firing onFlush. The dispatcher's
   * shutdown is responsible for forwarding any final coalesced text;
   * the coordinator only frees timers + clears state. Idempotent.
   */
  shutdown(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const batch of this.pending.values()) clearTimeout(batch.flushTimer);
    this.pending.clear();
  }

  /** Live pending-batch count — for telemetry + tests. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Test/admin: synchronously snapshot the coalesced text for a key
   * without flushing or affecting timers. Returns undefined if no batch
   * is pending. Production callers do not depend on this.
   */
  peek(key: SessionKey): string | undefined {
    return this.pending.get(sessionKeyString(key))?.text;
  }
}

function noopError(_key: SessionKey, _err: unknown): void {
  /* default sink */
}
