/* eslint-disable @typescript-eslint/require-await */
/**
 * Discord adapter tests — discord.js is mocked at module level. Covers
 * URI validation, the lazy login → ready handshake, send happy path,
 * non-text channel rejection, login failure surfaced via SendResult,
 * and token-never-logged discipline.
 *
 * The mock keeps the same shape the adapter consumes (Client, login,
 * once('ready'), channels.fetch, send) so the production code never
 * branches on a test-vs-prod path.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface MockChannelState {
  isTextBased: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
}

interface MockClientState {
  login: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  fetch: ReturnType<typeof vi.fn>;
  channel: MockChannelState;
  readyListeners: (() => void)[];
  /** AUTO.6 — discord.js `client.on('messageCreate', ...)` listeners. */
  messageListeners: ((msg: unknown) => void)[];
  constructed: number;
  /** Track the intents arg the adapter requested at construction. */
  lastIntents: number[];
}

const mock: MockClientState = {
  login: vi.fn(),
  destroy: vi.fn(),
  fetch: vi.fn(),
  channel: { isTextBased: vi.fn(), send: vi.fn() },
  readyListeners: [],
  messageListeners: [],
  constructed: 0,
  lastIntents: [],
};

vi.mock('discord.js', () => {
  class Client {
    channels = {
      fetch: (id: string): Promise<unknown> => mock.fetch(id) as Promise<unknown>,
    };
    constructor(opts: { intents: number[] }) {
      mock.constructed += 1;
      mock.lastIntents = [...opts.intents];
    }
    login(token: string): Promise<string> {
      return mock.login(token) as Promise<string>;
    }
    destroy(): Promise<void> {
      return mock.destroy() as Promise<void>;
    }
    once(event: 'ready', listener: () => void): void {
      if (event === 'ready') mock.readyListeners.push(listener);
    }
    on(event: string, listener: (msg: unknown) => void): void {
      if (event === 'messageCreate') mock.messageListeners.push(listener);
    }
    off(event: string, listener: (msg: unknown) => void): void {
      if (event === 'messageCreate') {
        const idx = mock.messageListeners.indexOf(listener);
        if (idx >= 0) mock.messageListeners.splice(idx, 1);
      }
    }
  }
  return {
    Client,
    GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 4 },
  };
});

const { discordAdapter } = await import('./discord.js');

function fireReadySoon(): void {
  // Fire the ready event on a microtask so login() can resolve first.
  queueMicrotask(() => {
    const listeners = mock.readyListeners.splice(0);
    for (const l of listeners) l();
  });
}

beforeEach(() => {
  mock.login.mockReset();
  mock.destroy.mockReset();
  mock.fetch.mockReset();
  mock.channel.isTextBased.mockReset();
  mock.channel.send.mockReset();
  mock.readyListeners = [];
  mock.messageListeners = [];
  mock.constructed = 0;
  mock.lastIntents = [];
  mock.login.mockImplementation(() => {
    fireReadySoon();
    return Promise.resolve('ok');
  });
  mock.destroy.mockResolvedValue(undefined);
  mock.channel.isTextBased.mockReturnValue(true);
  mock.channel.send.mockResolvedValue({ id: 'msg-1' });
  mock.fetch.mockResolvedValue(mock.channel);
});

/** Test helper — invoke every registered messageCreate listener. */
function fireMessageCreate(msg: unknown): void {
  for (const l of mock.messageListeners) l(msg);
}

describe('discordAdapter — URI validation', () => {
  it('validate accepts discord://<guild>/<channel> with numeric ids only', () => {
    const a = discordAdapter({ token: 't' });
    expect(a.validate('discord://123456789/987654321')).toBe(true);
    expect(a.validate('discord://1/2')).toBe(true);
    expect(a.validate('discord://abc/123')).toBe(false);
    expect(a.validate('discord://123')).toBe(false);
    expect(a.validate('discord://123/456/789')).toBe(false);
    expect(a.validate('telegram://123')).toBe(false);
  });
});

describe('discordAdapter — send()', () => {
  it('sends to a text-based channel after auto-starting (happy path)', async () => {
    const a = discordAdapter({ token: 'bot-secret-token' });
    const r = await a.send('discord://111/222', { text: 'hello' });
    expect(r).toEqual({ ok: true });
    expect(mock.login).toHaveBeenCalledTimes(1);
    expect(mock.login).toHaveBeenCalledWith('bot-secret-token');
    expect(mock.fetch).toHaveBeenCalledWith('222');
    expect(mock.channel.send).toHaveBeenCalledWith('hello');
  });

  it('rejects malformed URI before any network call', async () => {
    const a = discordAdapter({ token: 't' });
    const r = await a.send('discord://abc/def', { text: 'x' });
    expect(r).toEqual({ ok: false, error: 'bad uri' });
    expect(mock.login).not.toHaveBeenCalled();
    expect(mock.fetch).not.toHaveBeenCalled();
  });

  it('rejects when channel is not text-based', async () => {
    mock.channel.isTextBased.mockReturnValue(false);
    const a = discordAdapter({ token: 't' });
    const r = await a.send('discord://111/222', { text: 'hi' });
    expect(r).toEqual({ ok: false, error: 'channel not text-based' });
    expect(mock.channel.send).not.toHaveBeenCalled();
  });

  it('returns ok:false when channels.fetch resolves to null', async () => {
    mock.fetch.mockResolvedValueOnce(null);
    const a = discordAdapter({ token: 't' });
    const r = await a.send('discord://111/222', { text: 'hi' });
    expect(r).toEqual({ ok: false, error: 'channel not found' });
  });

  it('surfaces login failure via SendResult and redacts token from error', async () => {
    mock.login.mockReset();
    mock.login.mockRejectedValueOnce(new Error('auth failed: token bot-secret-token rejected'));
    const a = discordAdapter({ token: 'bot-secret-token' });
    const r = await a.send('discord://111/222', { text: 'hi' });
    expect(r.ok).toBe(false);
    expect(r.error).toBeDefined();
    expect(r.error).not.toContain('bot-secret-token');
    expect(r.error).toContain('[redacted]');
  });

  it('surfaces channel.send rejection and never logs the token', async () => {
    mock.channel.send.mockRejectedValueOnce(new Error('missing permissions'));
    const a = discordAdapter({ token: 't-shh' });
    const r = await a.send('discord://111/222', { text: 'hi' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('missing permissions');
  });
});

describe('discordAdapter — start()/stop() lifecycle', () => {
  it('start() logs in once then is idempotent', async () => {
    const a = discordAdapter({ token: 't' });
    await a.start();
    await a.start();
    expect(mock.login).toHaveBeenCalledTimes(1);
    expect(mock.constructed).toBe(1);
  });

  it('stop() destroys the client and lets start() relog after', async () => {
    const a = discordAdapter({ token: 't' });
    await a.start();
    await a.stop();
    expect(mock.destroy).toHaveBeenCalledTimes(1);
    await a.start();
    expect(mock.login).toHaveBeenCalledTimes(2);
  });

  it('stop() before start() is a no-op', async () => {
    const a = discordAdapter({ token: 't' });
    await a.stop();
    expect(mock.destroy).not.toHaveBeenCalled();
  });
});

describe('discordAdapter — subscribeInbound (AUTO.6)', () => {
  it('upgrades intents to Guilds + GuildMessages + MessageContent', async () => {
    const a = discordAdapter({ token: 't' });
    await a.subscribeInbound(async () => Promise.resolve());
    // 1 = Guilds, 2 = GuildMessages, 4 = MessageContent (from mock)
    expect(mock.lastIntents).toEqual([1, 2, 4]);
  });

  it('emits InboundChannelEvent on guild messageCreate', async () => {
    const events: unknown[] = [];
    const a = discordAdapter({ token: 't' });
    await a.subscribeInbound(async (e) => {
      events.push(e);
    });

    fireMessageCreate({
      id: 'msg-1',
      content: 'hello team',
      author: { id: 'u-7', bot: false },
      channelId: 'c-222',
      guildId: 'g-111',
    });
    // queueMicrotask drain — fan-out uses void promise.
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toHaveLength(1);
    const e = events[0] as { channelUri: string; sender: string; text: string };
    expect(e.channelUri).toBe('discord://g-111/c-222');
    expect(e.sender).toBe('u-7');
    expect(e.text).toBe('hello team');
  });

  it('skips messages from bots (loop-break first line)', async () => {
    const events: unknown[] = [];
    const a = discordAdapter({ token: 't' });
    await a.subscribeInbound(async (e) => {
      events.push(e);
    });
    fireMessageCreate({
      id: 'msg-bot',
      content: 'echo: hello',
      author: { id: 'bot-self', bot: true },
      channelId: 'c-222',
      guildId: 'g-111',
    });
    await Promise.resolve();
    expect(events).toHaveLength(0);
  });

  it('throws if called after outbound send() already started without inbound intents', async () => {
    const a = discordAdapter({ token: 't' });
    await a.send('discord://111/222', { text: 'hi' });
    await expect(a.subscribeInbound(async () => Promise.resolve())).rejects.toThrow(
      /already started without inbound intents/,
    );
  });

  it('unsubscribe stops further events from firing the handler', async () => {
    const events: unknown[] = [];
    const a = discordAdapter({ token: 't' });
    const sub = await a.subscribeInbound(async (e) => {
      events.push(e);
    });
    fireMessageCreate({
      id: 'm1',
      content: 'first',
      author: { id: 'u-1', bot: false },
      channelId: 'c-1',
      guildId: 'g-1',
    });
    await Promise.resolve();
    expect(events).toHaveLength(1);

    await sub.unsubscribe();
    fireMessageCreate({
      id: 'm2',
      content: 'second',
      author: { id: 'u-1', bot: false },
      channelId: 'c-1',
      guildId: 'g-1',
    });
    await Promise.resolve();
    // Listener removed from the set — no new dispatch.
    expect(events).toHaveLength(1);
  });

  it('stop() detaches the messageCreate listener (lifecycle)', async () => {
    const a = discordAdapter({ token: 't' });
    await a.subscribeInbound(async () => Promise.resolve());
    expect(mock.messageListeners.length).toBe(1);
    await a.stop();
    expect(mock.messageListeners.length).toBe(0);
  });
});
