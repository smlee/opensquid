import { describe, it, expect, vi } from 'vitest';
import { chatEscalator } from './escalator.js';

const msg = { reason: 'SCOPE_FORK' as const, text: '🦑 HUMAN_REQUIRED(SCOPE_FORK)' };

describe('chatEscalator', () => {
  it('delivers to the configured channel and reports escalated:true', async () => {
    const send = vi.fn(() => Promise.resolve({ ok: true }));
    const esc = chatEscalator({ send, channel: 'project:telegram' });
    const res = await esc(msg);
    expect(res.escalated).toBe(true);
    expect(send).toHaveBeenCalledWith({ channel: 'project:telegram', text: msg.text });
  });

  it('a transport that reports failure → escalated:false (so escalateLap throws — undroppable)', async () => {
    const send = vi.fn(() => Promise.resolve({ ok: false, reason: 'daemon unreachable' }));
    const res = await chatEscalator({ send, channel: 'c' })(msg);
    expect(res.escalated).toBe(false);
    expect(res.reason).toMatch(/unreachable/);
  });

  it('a transport that THROWS is caught and reported (not swallowed) → escalated:false', async () => {
    const send = vi.fn(() => Promise.reject(new Error('socket ECONNREFUSED')));
    const res = await chatEscalator({ send, channel: 'c' })(msg);
    expect(res.escalated).toBe(false);
    expect(res.reason).toMatch(/ECONNREFUSED/);
  });
});
