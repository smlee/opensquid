/**
 * LMP.2/LMP.6 — the `set_loop_phase` MCP tool: the pack-facing phase-emit at the push stream's phase choke-point.
 *
 * Covers the wg-id resolution precedence (explicit arg → OPENSQUID_ITEM_ID → session checkpoint key), the loud
 * error when nothing resolves, and that the resolved id + opaque label + lifecycle are PUSHED as a
 * phase_enter/phase_leave MonitorEvent (the redundant `loop_phases` store is retired — the emit is the sole
 * write). The emit, session resolver, and checkpoint-key resolver are mocked — this pins the tool's contract.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../runtime/loop/monitor_emit.js', () => ({
  emitMonitorEvent: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../runtime/hooks/session_id.js', () => ({
  resolveMcpSessionId: vi.fn(() => Promise.resolve(null)),
}));
vi.mock('../../runtime/loop/checkpoint_key.js', () => ({
  resolveCheckpointKey: vi.fn(() => Promise.resolve(null)),
}));

import { emitMonitorEvent } from '../../runtime/loop/monitor_emit.js';
import { resolveMcpSessionId } from '../../runtime/hooks/session_id.js';
import { resolveCheckpointKey } from '../../runtime/loop/checkpoint_key.js';
import { handleSetLoopPhase } from './set_loop_phase.js';

const mockEmit = vi.mocked(emitMonitorEvent);
const mockSession = vi.mocked(resolveMcpSessionId);
const mockKey = vi.mocked(resolveCheckpointKey);
const savedItem = process.env.OPENSQUID_ITEM_ID;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.OPENSQUID_ITEM_ID;
  mockSession.mockResolvedValue(null);
  mockKey.mockResolvedValue(null);
});
afterEach(() => {
  if (savedItem === undefined) delete process.env.OPENSQUID_ITEM_ID;
  else process.env.OPENSQUID_ITEM_ID = savedItem;
});

describe('handleSetLoopPhase', () => {
  it('an explicit wg_id wins and is pushed as a phase_enter (default running)', async () => {
    process.env.OPENSQUID_ITEM_ID = 'wg-env';
    const out = await handleSetLoopPhase({
      phase: 'test',
      index: 4,
      total: 7,
      wg_id: 'wg-explicit',
    });
    expect(out).toEqual({
      ok: true,
      wg_id: 'wg-explicit',
      phase: 'test',
      index: 4,
      total: 7,
      lifecycle: 'running',
    });
    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        wgId: 'wg-explicit',
        kind: 'phase_enter',
        phase: 'test',
        index: 4,
        total: 7,
        lifecycle: 'running',
      }),
    );
  });

  it('lifecycle:"done" is pushed as a phase_leave', async () => {
    const out = await handleSetLoopPhase({ phase: 'test', lifecycle: 'done', wg_id: 'wg-a' });
    expect(out.lifecycle).toBe('done');
    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({ wgId: 'wg-a', kind: 'phase_leave', lifecycle: 'done' }),
    );
  });

  it('falls back to OPENSQUID_ITEM_ID when no explicit wg_id is passed', async () => {
    process.env.OPENSQUID_ITEM_ID = 'wg-env';
    const out = await handleSetLoopPhase({ phase: 'code' });
    expect(out.wg_id).toBe('wg-env');
    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({ wgId: 'wg-env', kind: 'phase_enter' }),
    );
  });

  it('falls back to the session’s checkpoint key when neither arg nor env is set', async () => {
    mockSession.mockResolvedValue('sid-1');
    mockKey.mockResolvedValue('wg-session');
    const out = await handleSetLoopPhase({ phase: 'plan', index: 1, total: 2 });
    expect(out.wg_id).toBe('wg-session');
    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({ wgId: 'wg-session', phase: 'plan' }),
    );
  });

  it('throws a loud error when no item resolves (nothing to key the phase to)', async () => {
    await expect(handleSetLoopPhase({ phase: 'test' })).rejects.toThrow(
      /no item to key the phase to/,
    );
    expect(mockEmit).not.toHaveBeenCalled();
  });
});
