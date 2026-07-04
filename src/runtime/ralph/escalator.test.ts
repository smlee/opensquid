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

  it('forwards a resolved LITERAL telegram channel + forum threadId to the transport (not the project: shorthand)', async () => {
    // The fix: the CLI resolves cwd → `telegram:<chat_id>` + topic `threadId` and passes THAT here — the
    // daemon gateway only accepts the `<platform>:<native_id>` wire form (`project:telegram` was rejected).
    const send = vi.fn(() => Promise.resolve({ ok: true }));
    const esc = chatEscalator({ send, channel: 'telegram:-1003923174632', threadId: '15' });
    const res = await esc(msg);
    expect(res.escalated).toBe(true);
    expect(send).toHaveBeenCalledWith({
      channel: 'telegram:-1003923174632',
      text: msg.text,
      threadId: '15',
    });
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
