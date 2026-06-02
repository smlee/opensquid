/* eslint-disable @typescript-eslint/require-await */
/**
 * Factory tests (CAT.1b) — grammy is mocked (getMe seam is injected, so the
 * mock only needs to satisfy the `new Bot()` the adapter constructs).
 *
 * Covers: telegram adapter built from config with allowlist + botUsername;
 * platforms without a token skipped; discord/slack reported as skipped.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('grammy', () => {
  class Bot {
    api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 1, date: 0 }),
      deleteWebhook: vi.fn().mockResolvedValue(true),
      getMe: vi.fn().mockResolvedValue({ id: 1, is_bot: true, username: 'unused' }),
      createForumTopic: vi.fn(),
    };
    start = vi.fn().mockReturnValue(
      new Promise<void>(() => {
        /* bot.start() resolves on shutdown only */
      }),
    );
    stop = vi.fn().mockResolvedValue(undefined);
    on = vi.fn();
    constructor(token: string) {
      void token;
    }
  }
  class GrammyError extends Error {}
  class HttpError extends Error {}
  return { Bot, GrammyError, HttpError };
});

const { buildChatAdapters } = await import('./factory.js');

describe('buildChatAdapters — telegram', () => {
  it('builds a telegram adapter from config with parsed allowlist + resolved botUsername', async () => {
    const result = await buildChatAdapters({
      config: { telegram: { bot_token: '123:abc', allowlist_chat_ids: ['8075471258', '-100123'] } },
      resolveBotUsername: async () => 'squidbot',
    });
    expect(result.activated).toEqual(['telegram']);
    expect(result.adapters.has('telegram')).toBe(true);
    const tg = result.adapters.get('telegram');
    // The adapter enforces the allowlist on send — assert the numeric parse
    // landed by sending to an allowlisted vs non-allowlisted chat.
    expect(tg).toBeDefined();
    const okSend = await tg!.send('telegram://8075471258', { text: 'hi' });
    expect(okSend.ok).toBe(true);
    const blocked = await tg!.send('telegram://999', { text: 'hi' });
    expect(blocked).toEqual({ ok: false, error: 'chat not in allowlist' });
  });

  it('still activates telegram when getMe (botUsername resolution) fails — non-fatal', async () => {
    const result = await buildChatAdapters({
      config: { telegram: { bot_token: '123:abc', allowlist_chat_ids: ['1'] } },
      resolveBotUsername: async () => {
        throw new Error('network down');
      },
    });
    expect(result.activated).toEqual(['telegram']);
    expect(result.issues.some((i) => i.includes('getMe failed'))).toBe(true);
  });

  it('skips telegram when the token is malformed (validation issue)', async () => {
    const result = await buildChatAdapters({
      config: { telegram: { bot_token: 'not-a-token' } },
      resolveBotUsername: async () => undefined,
    });
    expect(result.activated).toEqual([]);
    expect(result.adapters.has('telegram')).toBe(false);
    expect(result.issues.some((i) => i.startsWith('telegram skipped'))).toBe(true);
  });

  it('builds nothing for an empty config', async () => {
    const result = await buildChatAdapters({ config: {}, resolveBotUsername: async () => undefined });
    expect(result.activated).toEqual([]);
    expect(result.adapters.size).toBe(0);
  });
});

describe('buildChatAdapters — discord / slack skipped', () => {
  it('reports discord + slack as skipped (no subscribeTransport surface yet)', async () => {
    const result = await buildChatAdapters({
      config: {
        telegram: { bot_token: '123:abc', allowlist_chat_ids: ['1'] },
        discord: { bot_token: 'disc' },
        slack: { bot_token: 'xoxb-x', app_token: 'xapp-x' },
      },
      resolveBotUsername: async () => 'b',
    });
    expect(result.activated).toEqual(['telegram']);
    expect(result.adapters.has('discord')).toBe(false);
    expect(result.adapters.has('slack')).toBe(false);
    expect(result.issues.some((i) => i.startsWith('discord skipped'))).toBe(true);
    expect(result.issues.some((i) => i.startsWith('slack skipped'))).toBe(true);
  });
});
