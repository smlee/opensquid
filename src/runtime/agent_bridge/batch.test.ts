/**
 * agent_bridge — BatchCoordinator unit tests (WAB.5, 0.5.99).
 *
 * Fixtures aligned with WAB.5 spec test plan:
 *   - single small message → flush after fast-tier delay (180 ms)
 *   - two short messages within 100 ms → coalesce → single flush after
 *     fast-tier
 *   - medium message (~500 chars) → flush after short-tier delay (240 ms)
 *   - split-threshold message (4000 chars) → flush after split delay
 *     (1500 ms); next chunk within window re-coalesces
 *   - default-tier (>1024 chars) → flush after default delay (1200 ms)
 *   - shutdown clears all pending timers (no leak)
 *   - empty text ingest is a no-op (no pending batch installed)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BatchCoordinator,
  TEXT_BATCH_DELAY_MS_DEFAULT,
  TEXT_BATCH_FAST_DELAY_MS,
  TEXT_BATCH_FAST_LEN,
  TEXT_BATCH_SHORT_DELAY_MS,
  TEXT_BATCH_SHORT_LEN,
  TEXT_BATCH_SPLIT_DELAY_MS,
  TG_SPLIT_THRESHOLD,
} from './batch.js';
import type { SessionKey } from './types.js';

const KEY: SessionKey = { platform: 'telegram', chatId: '8075471258' };
const OTHER_KEY: SessionKey = { platform: 'telegram', chatId: '9000000000' };

interface FlushCapture {
  key: SessionKey;
  text: string;
}

function makeCoordinator(flushes: FlushCapture[], errors: unknown[] = []): BatchCoordinator {
  return new BatchCoordinator({
    onFlush: (key, text) => {
      flushes.push({ key, text });
      return Promise.resolve();
    },
    onError: (_key, err) => {
      errors.push(err);
    },
  });
}

describe('BatchCoordinator constants', () => {
  it('matches Hermes-verified thresholds', () => {
    // gateway/platforms/telegram.py:281,291-294 — verified during WAB.1.
    expect(TG_SPLIT_THRESHOLD).toBe(4000);
    expect(TEXT_BATCH_FAST_LEN).toBe(320);
    expect(TEXT_BATCH_SHORT_LEN).toBe(1024);
    expect(TEXT_BATCH_FAST_DELAY_MS).toBe(180);
    expect(TEXT_BATCH_SHORT_DELAY_MS).toBe(240);
    expect(TEXT_BATCH_DELAY_MS_DEFAULT).toBe(1200);
    expect(TEXT_BATCH_SPLIT_DELAY_MS).toBe(1500);
  });
});

describe('BatchCoordinator with fake timers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('flushes a single small message after fast-tier delay', async () => {
    const flushes: FlushCapture[] = [];
    const coord = makeCoordinator(flushes);
    coord.ingest(KEY, 'hi');
    expect(coord.pendingCount).toBe(1);
    // Just before fast delay → still pending.
    await vi.advanceTimersByTimeAsync(TEXT_BATCH_FAST_DELAY_MS - 10);
    expect(flushes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(20);
    expect(flushes).toHaveLength(1);
    expect(flushes[0]?.text).toBe('hi');
    expect(flushes[0]?.key).toEqual(KEY);
    expect(coord.pendingCount).toBe(0);
    coord.shutdown();
  });

  it('coalesces two short messages within the quiet period into one flush', async () => {
    const flushes: FlushCapture[] = [];
    const coord = makeCoordinator(flushes);
    coord.ingest(KEY, 'hello');
    await vi.advanceTimersByTimeAsync(50);
    coord.ingest(KEY, 'there');
    // Timer should have been reset; advance just past the second
    // chunk's fast-tier window.
    await vi.advanceTimersByTimeAsync(TEXT_BATCH_FAST_DELAY_MS + 10);
    expect(flushes).toHaveLength(1);
    expect(flushes[0]?.text).toBe('hello\nthere');
    coord.shutdown();
  });

  it('uses short-tier delay for a medium message (~500 chars)', async () => {
    const flushes: FlushCapture[] = [];
    const coord = makeCoordinator(flushes);
    coord.ingest(KEY, 'x'.repeat(500));
    // Should NOT fire at fast-tier boundary.
    await vi.advanceTimersByTimeAsync(TEXT_BATCH_FAST_DELAY_MS + 10);
    expect(flushes).toHaveLength(0);
    // Should fire at short-tier boundary.
    await vi.advanceTimersByTimeAsync(
      TEXT_BATCH_SHORT_DELAY_MS - TEXT_BATCH_FAST_DELAY_MS - 10 + 10,
    );
    expect(flushes).toHaveLength(1);
    expect(flushes[0]?.text.length).toBe(500);
    coord.shutdown();
  });

  it('uses split-tier delay when last chunk is at/above the split threshold', async () => {
    const flushes: FlushCapture[] = [];
    const coord = makeCoordinator(flushes);
    coord.ingest(KEY, 'a'.repeat(TG_SPLIT_THRESHOLD)); // exactly threshold
    // Should NOT fire at short-tier boundary — split delay is longer.
    await vi.advanceTimersByTimeAsync(TEXT_BATCH_SHORT_DELAY_MS + 10);
    expect(flushes).toHaveLength(0);
    // Should NOT fire at default-tier boundary either.
    await vi.advanceTimersByTimeAsync(TEXT_BATCH_DELAY_MS_DEFAULT);
    expect(flushes).toHaveLength(0);
    // Should fire at split-tier boundary.
    await vi.advanceTimersByTimeAsync(
      TEXT_BATCH_SPLIT_DELAY_MS - TEXT_BATCH_DELAY_MS_DEFAULT - TEXT_BATCH_SHORT_DELAY_MS - 10 + 10,
    );
    expect(flushes).toHaveLength(1);
    expect(flushes[0]?.text.length).toBe(TG_SPLIT_THRESHOLD);
    coord.shutdown();
  });

  it('re-coalesces when a continuation chunk arrives within the split window', async () => {
    const flushes: FlushCapture[] = [];
    const coord = makeCoordinator(flushes);
    coord.ingest(KEY, 'a'.repeat(TG_SPLIT_THRESHOLD));
    await vi.advanceTimersByTimeAsync(500);
    coord.ingest(KEY, 'continuation');
    // After the second chunk, the total is large — default tier
    // applies (lastChunkLen=12 < threshold, total > SHORT_LEN).
    await vi.advanceTimersByTimeAsync(TEXT_BATCH_DELAY_MS_DEFAULT + 10);
    expect(flushes).toHaveLength(1);
    expect(flushes[0]?.text.endsWith('\ncontinuation')).toBe(true);
    expect(flushes[0]?.text.length).toBe(TG_SPLIT_THRESHOLD + '\ncontinuation'.length);
    coord.shutdown();
  });

  it('uses default-tier delay for messages above the short-tier cap', async () => {
    const flushes: FlushCapture[] = [];
    const coord = makeCoordinator(flushes);
    coord.ingest(KEY, 'x'.repeat(TEXT_BATCH_SHORT_LEN + 100));
    await vi.advanceTimersByTimeAsync(TEXT_BATCH_SHORT_DELAY_MS + 10);
    expect(flushes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(
      TEXT_BATCH_DELAY_MS_DEFAULT - TEXT_BATCH_SHORT_DELAY_MS - 10 + 10,
    );
    expect(flushes).toHaveLength(1);
    coord.shutdown();
  });

  it('keeps per-session batches independent', async () => {
    const flushes: FlushCapture[] = [];
    const coord = makeCoordinator(flushes);
    coord.ingest(KEY, 'one');
    coord.ingest(OTHER_KEY, 'two');
    expect(coord.pendingCount).toBe(2);
    await vi.advanceTimersByTimeAsync(TEXT_BATCH_FAST_DELAY_MS + 10);
    expect(flushes).toHaveLength(2);
    const texts = flushes.map((f) => f.text).sort();
    expect(texts).toEqual(['one', 'two']);
    coord.shutdown();
  });

  it('shutdown clears all pending timers (no leak, no late flush)', async () => {
    const flushes: FlushCapture[] = [];
    const coord = makeCoordinator(flushes);
    coord.ingest(KEY, 'pending');
    coord.ingest(OTHER_KEY, 'also pending');
    expect(coord.pendingCount).toBe(2);
    coord.shutdown();
    expect(coord.pendingCount).toBe(0);
    // Advance way past every tier — nothing should fire.
    await vi.advanceTimersByTimeAsync(TEXT_BATCH_SPLIT_DELAY_MS * 5);
    expect(flushes).toHaveLength(0);
    // libvitest's pending-timer count after shutdown.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores empty-string ingests', async () => {
    const flushes: FlushCapture[] = [];
    const coord = makeCoordinator(flushes);
    coord.ingest(KEY, '');
    expect(coord.pendingCount).toBe(0);
    await vi.advanceTimersByTimeAsync(TEXT_BATCH_SPLIT_DELAY_MS + 10);
    expect(flushes).toHaveLength(0);
    coord.shutdown();
  });

  it('peek returns coalesced text without affecting flush', async () => {
    const flushes: FlushCapture[] = [];
    const coord = makeCoordinator(flushes);
    coord.ingest(KEY, 'a');
    coord.ingest(KEY, 'b');
    expect(coord.peek(KEY)).toBe('a\nb');
    expect(coord.peek(OTHER_KEY)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(TEXT_BATCH_FAST_DELAY_MS + 10);
    expect(flushes).toHaveLength(1);
    coord.shutdown();
  });

  it('forwards onFlush rejections to onError', async () => {
    const flushes: FlushCapture[] = [];
    const errors: unknown[] = [];
    const coord = new BatchCoordinator({
      onFlush: () => Promise.reject(new Error('boom')),
      onError: (_key, err) => {
        errors.push(err);
      },
    });
    coord.ingest(KEY, 'hi');
    await vi.advanceTimersByTimeAsync(TEXT_BATCH_FAST_DELAY_MS + 10);
    // Microtask drain so the awaited onFlush rejection lands in
    // the catch.
    await Promise.resolve();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('boom');
    expect(flushes).toHaveLength(0);
    coord.shutdown();
  });

  it('respects per-call delay overrides', async () => {
    const flushes: FlushCapture[] = [];
    const coord = new BatchCoordinator({
      onFlush: (key, text) => {
        flushes.push({ key, text });
        return Promise.resolve();
      },
      fastDelayMs: 50,
      defaultDelayMs: 100,
    });
    coord.ingest(KEY, 'tiny');
    await vi.advanceTimersByTimeAsync(60);
    expect(flushes).toHaveLength(1);
    coord.shutdown();
  });

  it('caps fast tier at min(default, fast) when default is smaller', async () => {
    const flushes: FlushCapture[] = [];
    const coord = new BatchCoordinator({
      onFlush: (key, text) => {
        flushes.push({ key, text });
        return Promise.resolve();
      },
      // Operator lowers the default cap below fast tier — fast tier
      // should clamp to the smaller value.
      fastDelayMs: 180,
      defaultDelayMs: 50,
    });
    coord.ingest(KEY, 'short');
    await vi.advanceTimersByTimeAsync(60);
    expect(flushes).toHaveLength(1);
    coord.shutdown();
  });
});
