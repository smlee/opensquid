/**
 * LSF.2 — the `set_loop_phase` MCP tool: the pack-facing emit for the wg-keyed phase store.
 *
 * Covers the wg-id resolution precedence (explicit arg → OPENSQUID_ITEM_ID → session checkpoint key), the
 * loud error when nothing resolves, and that the resolved id + opaque label are forwarded to `setLoopPhase`.
 * The store, session resolver, and checkpoint-key resolver are mocked — this pins the tool's own contract.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../runtime/loop/loop_phase_store.js', () => ({
  setLoopPhase: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../runtime/hooks/session_id.js', () => ({
  resolveMcpSessionId: vi.fn(() => Promise.resolve(null)),
}));
vi.mock('../../runtime/loop/checkpoint_key.js', () => ({
  resolveCheckpointKey: vi.fn(() => Promise.resolve(null)),
}));

import { setLoopPhase } from '../../runtime/loop/loop_phase_store.js';
import { resolveMcpSessionId } from '../../runtime/hooks/session_id.js';
import { resolveCheckpointKey } from '../../runtime/loop/checkpoint_key.js';
import { handleSetLoopPhase } from './set_loop_phase.js';

const mockSet = vi.mocked(setLoopPhase);
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
  it('an explicit wg_id wins and is forwarded to setLoopPhase', async () => {
    process.env.OPENSQUID_ITEM_ID = 'wg-env';
    const out = await handleSetLoopPhase({
      phase: 'test',
      index: 4,
      total: 7,
      wg_id: 'wg-explicit',
    });
    expect(out).toEqual({ ok: true, wg_id: 'wg-explicit', phase: 'test', index: 4, total: 7 });
    expect(mockSet).toHaveBeenCalledWith('wg-explicit', 'test', 4, 7);
  });

  it('falls back to OPENSQUID_ITEM_ID when no explicit wg_id is passed', async () => {
    process.env.OPENSQUID_ITEM_ID = 'wg-env';
    const out = await handleSetLoopPhase({ phase: 'code' });
    expect(out.wg_id).toBe('wg-env');
    expect(mockSet).toHaveBeenCalledWith('wg-env', 'code', null, null); // omitted counters → null
  });

  it('falls back to the session’s checkpoint key when neither arg nor env is set', async () => {
    mockSession.mockResolvedValue('sid-1');
    mockKey.mockResolvedValue('wg-session');
    const out = await handleSetLoopPhase({ phase: 'plan', index: 1, total: 2 });
    expect(out.wg_id).toBe('wg-session');
    expect(mockSet).toHaveBeenCalledWith('wg-session', 'plan', 1, 2);
  });

  it('throws a loud error when no item resolves (nothing to key the phase to)', async () => {
    await expect(handleSetLoopPhase({ phase: 'test' })).rejects.toThrow(
      /no item to key the phase to/,
    );
    expect(mockSet).not.toHaveBeenCalled();
  });
});
