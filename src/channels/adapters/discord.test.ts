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
  constructed: number;
}

const mock: MockClientState = {
  login: vi.fn(),
  destroy: vi.fn(),
  fetch: vi.fn(),
  channel: { isTextBased: vi.fn(), send: vi.fn() },
  readyListeners: [],
  constructed: 0,
};

vi.mock('discord.js', () => {
  class Client {
    channels = {
      fetch: (id: string): Promise<unknown> => mock.fetch(id) as Promise<unknown>,
    };
    constructor(_opts: { intents: number[] }) {
      mock.constructed += 1;
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
  }
  return { Client, GatewayIntentBits: { Guilds: 1 } };
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
  mock.constructed = 0;
  mock.login.mockImplementation(() => {
    fireReadySoon();
    return Promise.resolve('ok');
  });
  mock.destroy.mockResolvedValue(undefined);
  mock.channel.isTextBased.mockReturnValue(true);
  mock.channel.send.mockResolvedValue({ id: 'msg-1' });
  mock.fetch.mockResolvedValue(mock.channel);
});

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
