/**
 * Report → chat delivery (the "user receives NOTHING in chat" fix).
 *
 * `surfaceReportToChat` used to ship the `project:telegram` shorthand straight to the chat-daemon, whose
 * `gateway.parseChannel` REJECTS platform `project` — so every push silently failed (the error was swallowed
 * by the fail-open catch). It must now resolve the cwd → the daemon's literal `telegram:<chat_id>` (+ topic
 * threadId) BEFORE calling `sendChat`, exactly like the MCP chat-bridge's `resolveProjectChannel`.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock the daemon client (no real socket) + the on-disk channels config (no real ~/.opensquid/channels.json).
// The routing mock keeps the REAL resolvers (resolveTelegramChannel/resolveUmbrellaForCwd) — only the disk read
// (loadChannelsConfig) is stubbed — so the test exercises the actual resolution surfaceReportToChat depends on.
vi.mock('../../chat_daemon/client.js', () => ({
  sendChat: vi.fn(() => Promise.resolve({ ok: true })),
}));
vi.mock('../../channels/routing.js', async () => {
  const actual = await vi.importActual('../../channels/routing.js');
  return { ...actual, loadChannelsConfig: vi.fn() };
});

import { sendChat } from '../../chat_daemon/client.js';
import { ChannelsConfig, loadChannelsConfig } from '../../channels/routing.js';
import { surfaceReportToChat } from './v2_supply.js';

const mockSend = vi.mocked(sendChat);
const mockLoad = vi.mocked(loadChannelsConfig);

const CFG = ChannelsConfig.parse({
  v: 1,
  umbrellas: [
    {
      id: 'loop',
      members: ['/Users/x/projects/opensquid'],
      telegram: { chat_id: '-100777', topic_id: 15 },
    },
  ],
});

describe('surfaceReportToChat (report → chat delivery)', () => {
  beforeEach(() => {
    mockSend.mockClear();
    mockLoad.mockReset();
  });

  it('sends the RESOLVED literal channel + threadId — NEVER the `project:telegram` shorthand', async () => {
    mockLoad.mockResolvedValue(CFG);
    await surfaceReportToChat('/Users/x/projects/opensquid', '🦑 PLAN complete · 14');
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith({
      channel: 'telegram:-100777',
      text: '🦑 PLAN complete · 14',
      threadId: '15',
    });
    // The prior bug: it shipped the shorthand the daemon rejects. Prove that never happens.
    expect(mockSend.mock.calls[0]?.[0].channel).not.toBe('project:telegram');
  });

  it('skips the send (best-effort) when no umbrella claims the cwd', async () => {
    mockLoad.mockResolvedValue(CFG);
    await surfaceReportToChat('/tmp/not-a-member', 'body');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('skips the send when there is no channels config (fail-open)', async () => {
    mockLoad.mockResolvedValue(null);
    await surfaceReportToChat('/Users/x/projects/opensquid', 'body');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('a sendChat failure NEVER throws (fail-open, observable on stderr)', async () => {
    mockLoad.mockResolvedValue(CFG);
    mockSend.mockRejectedValueOnce(new Error('daemon down'));
    await expect(
      surfaceReportToChat('/Users/x/projects/opensquid', 'body'),
    ).resolves.toBeUndefined();
  });
});
