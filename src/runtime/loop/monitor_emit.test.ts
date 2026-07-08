/**
 * LMP.2 — the fail-open `emitMonitorEvent` primitive.
 *
 * Covers the two-line contract: on success it forwards the event to the store (`appendMonitorEvent`); on a store
 * fault it SWALLOWS the error (logs to stderr) and NEVER throws — so a monitor-store fault can never break the
 * load-bearing mutation that called it. The store is mocked (this pins the wrapper's own contract; the
 * choke-point emits are asserted at their homes: loop_stage.test.ts / set_loop_phase.test.ts /
 * orchestrator.test.ts).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./loop_events.js', () => ({
  appendMonitorEvent: vi.fn(() => Promise.resolve()),
}));

import { appendMonitorEvent } from './loop_events.js';
import { emitMonitorEvent } from './monitor_emit.js';

const mockAppend = vi.mocked(appendMonitorEvent);

afterEach(() => vi.clearAllMocks());

describe('emitMonitorEvent', () => {
  it('forwards the event to the store on the happy path', async () => {
    const ev = { wgId: 'wg-a', kind: 'stage_advance' as const, stage: 'code', atMs: 1 };
    await emitMonitorEvent(ev);
    expect(mockAppend).toHaveBeenCalledWith(ev);
  });

  it('swallows a store fault (fail-open) — resolves without throwing', async () => {
    mockAppend.mockRejectedValueOnce(new Error('db down'));
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await expect(
      emitMonitorEvent({ wgId: 'wg-a', kind: 'stage_advance', stage: 'code', atMs: 1 }),
    ).resolves.toBeUndefined();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('[monitor] emit failed'));
    stderr.mockRestore();
  });
});
