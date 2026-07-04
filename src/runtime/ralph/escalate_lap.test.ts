/**
 * GR.3 — escalateLap is UNDROPPABLE: a successful escalation resolves; a failed delivery THROWS
 * (never a silent drop, Inv 6).
 */
import { describe, expect, it, vi } from 'vitest';

import { EscalationUndeliverableError, escalateLap, type LapEscalator } from './escalate_lap.js';

describe('escalateLap', () => {
  it('ALWAYS surfaces a clear ESCALATION line to stdout (in-session), independent of chat delivery', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      // delivered
      await escalateLap('BOARD_EMPTY', { escalate: () => Promise.resolve({ escalated: true }) });
      expect(out).toHaveBeenCalledWith('🦑 ESCALATION [BOARD_EMPTY]\n');
      // includes item + payload detail
      await escalateLap('SCOPE_FORK', {
        item: 'wg-abc',
        payload: { q: 1 },
        escalate: () => Promise.resolve({ escalated: true }),
      });
      expect(out).toHaveBeenCalledWith('🦑 ESCALATION [SCOPE_FORK] (item wg-abc) — {"q":1}\n');
      // STILL printed when chat delivery fails (the throw comes AFTER the in-session surface)
      out.mockClear();
      await expect(
        escalateLap('BUDGET', { escalate: () => Promise.resolve({ escalated: false }) }),
      ).rejects.toThrow(EscalationUndeliverableError);
      expect(out).toHaveBeenCalledWith('🦑 ESCALATION [BUDGET]\n');
    } finally {
      out.mockRestore();
    }
  });

  it('delivers the typed reason + item via the injected escalator', async () => {
    let seen: Parameters<LapEscalator>[0] | null = null;
    const escalate: LapEscalator = (m) => {
      seen = m;
      return Promise.resolve({ escalated: true });
    };
    await escalateLap('SCOPE_FORK', { item: 'wg-abc', payload: { q: 1 }, escalate });
    expect(seen).not.toBeNull();
    expect(seen!.reason).toBe('SCOPE_FORK');
    expect(seen!.item).toBe('wg-abc');
    expect(seen!.payload).toEqual({ q: 1 });
    expect(seen!.text).toContain('HUMAN_REQUIRED(SCOPE_FORK)');
    expect(seen!.text).toContain('wg-abc');
  });

  it('THROWS when delivery fails (undroppable, never silent)', async () => {
    const escalate: LapEscalator = () =>
      Promise.resolve({ escalated: false, reason: 'no_critical_channels' });
    await expect(escalateLap('BUDGET', { escalate })).rejects.toThrow(EscalationUndeliverableError);
    await expect(escalateLap('BUDGET', { escalate })).rejects.toThrow(/UNDELIVERABLE/);
  });

  it('omits item/payload from the message when absent', async () => {
    let seen: Parameters<LapEscalator>[0] | null = null;
    const escalate: LapEscalator = (m) => {
      seen = m;
      return Promise.resolve({ escalated: true });
    };
    await escalateLap('UNRECOVERABLE_WEDGE', { escalate });
    expect(seen!.item).toBeUndefined();
    expect(seen!.payload).toBeUndefined();
    expect(seen!.text).toBe('🦑 HUMAN_REQUIRED(UNRECOVERABLE_WEDGE)');
  });
});
