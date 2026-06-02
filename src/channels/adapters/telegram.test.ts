/* eslint-disable @typescript-eslint/require-await */
/**
 * Telegram adapter tests — grammy `Bot` is mocked. Covers URI parsing,
 * allowlist enforcement, optional topic_id, error mapping, outbound-only
 * semantics, and the 409 exponential-backoff retry path.
 *
 * NOTE: `bot.start()` resolves on shutdown only. The retry test asserts
 * the rejected `start()` triggers a re-call via setTimeout — we use
 * vitest's fake timers to advance time deterministically.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock state shared across the vi.mock factory + tests.
interface MockBotState {
  sendMessage: ReturnType<typeof vi.fn>;
  deleteWebhook: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  startCallCount: number;
  /** AUTO.6 — grammy `bot.on('message', ...)` listeners. The mock fires them
   *  in registration order when a test calls `fireMessage(ctx)`. */
  messageListeners: ((ctx: unknown) => void | Promise<void>)[];
}

const mockState: MockBotState = {
  sendMessage: vi.fn(),
  deleteWebhook: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  startCallCount: 0,
  messageListeners: [],
};

class FakeGrammyError extends Error {
  override readonly name = 'GrammyError';
  constructor(
    public readonly error_code: number,
    public readonly description: string,
  ) {
    super(`telegram api ${error_code}: ${description}`);
  }
}

class FakeHttpError extends Error {
  override readonly name = 'HttpError';
}

vi.mock('grammy', () => {
  class Bot {
    api = {
      sendMessage: (...args: unknown[]): unknown => mockState.sendMessage(...args),
      deleteWebhook: (...args: unknown[]): unknown => mockState.deleteWebhook(...args),
    };
    start(...args: unknown[]): Promise<void> {
      mockState.startCallCount += 1;
      return mockState.start(...args) as Promise<void>;
    }
    stop(...args: unknown[]): Promise<void> {
      return mockState.stop(...args) as Promise<void>;
    }
    on(filter: string, listener: (ctx: unknown) => void | Promise<void>): void {
      if (filter === 'message') {
        mockState.messageListeners.push(listener);
      }
    }
    constructor(token: string) {
      // token is captured by the constructor but unused in the mock;
      // kept named for parity with the real grammy.Bot signature.
      void token;
    }
  }
  return { Bot, GrammyError: FakeGrammyError, HttpError: FakeHttpError };
});

// Import AFTER vi.mock so the mocked module is used.
const { telegramAdapter } = await import('./telegram.js');

beforeEach(() => {
  mockState.sendMessage.mockReset();
  mockState.deleteWebhook.mockReset();
  mockState.start.mockReset();
  mockState.stop.mockReset();
  mockState.startCallCount = 0;
  mockState.messageListeners = [];
  mockState.sendMessage.mockResolvedValue({ message_id: 1, date: 0 });
  mockState.deleteWebhook.mockResolvedValue(true);
  // Default: start hangs (resolves only on shutdown).
  mockState.start.mockReturnValue(
    new Promise<void>(() => {
      /* never resolves — bot.start() resolves on shutdown only */
    }),
  );
  mockState.stop.mockResolvedValue(undefined);
});

/** Test helper — invoke every registered message listener with `ctx`. */
async function fireMessage(ctx: unknown): Promise<void> {
  for (const l of mockState.messageListeners) {
    await l(ctx);
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('telegramAdapter — URI validation', () => {
  it('validate accepts positive + negative chat IDs with optional topic', () => {
    const a = telegramAdapter({ token: 't', allowlistChatIds: [1] });
    expect(a.validate('telegram://12345')).toBe(true);
    expect(a.validate('telegram://-100123456')).toBe(true);
    expect(a.validate('telegram://12345/777')).toBe(true);
    expect(a.validate('telegram://abc')).toBe(false);
    expect(a.validate('chat://')).toBe(false);
    expect(a.validate('telegram://12345/abc')).toBe(false);
  });
});

describe('telegramAdapter — send()', () => {
  it('sends to an allowlisted chat without a topic', async () => {
    const a = telegramAdapter({ token: 't', allowlistChatIds: [12345] });
    const r = await a.send('telegram://12345', { text: 'hi' });
    expect(r).toEqual({ ok: true });
    expect(mockState.sendMessage).toHaveBeenCalledTimes(1);
    expect(mockState.sendMessage).toHaveBeenCalledWith(12345, 'hi', undefined);
  });

  it('passes message_thread_id when topic is present', async () => {
    const a = telegramAdapter({ token: 't', allowlistChatIds: [12345] });
    const r = await a.send('telegram://12345/777', { text: 'topic msg' });
    expect(r).toEqual({ ok: true });
    expect(mockState.sendMessage).toHaveBeenCalledWith(12345, 'topic msg', {
      message_thread_id: 777,
    });
  });

  it('rejects chat not in allowlist BEFORE any API call', async () => {
    const a = telegramAdapter({ token: 't', allowlistChatIds: [12345] });
    const r = await a.send('telegram://99999', { text: 'hi' });
    expect(r).toEqual({ ok: false, error: 'chat not in allowlist' });
    expect(mockState.sendMessage).not.toHaveBeenCalled();
  });

  it('rejects malformed URI with bad uri', async () => {
    const a = telegramAdapter({ token: 't', allowlistChatIds: [12345] });
    const r = await a.send('telegram://not-a-number', { text: 'hi' });
    expect(r).toEqual({ ok: false, error: 'bad uri' });
    expect(mockState.sendMessage).not.toHaveBeenCalled();
  });

  it('maps GrammyError to telegram api <code>: <desc>', async () => {
    mockState.sendMessage.mockRejectedValueOnce(new FakeGrammyError(403, 'Forbidden: bot blocked'));
    const a = telegramAdapter({ token: 't', allowlistChatIds: [12345] });
    const r = await a.send('telegram://12345', { text: 'hi' });
    expect(r).toEqual({ ok: false, error: 'telegram api 403: Forbidden: bot blocked' });
  });

  it('maps HttpError to network: <msg>', async () => {
    mockState.sendMessage.mockRejectedValueOnce(new FakeHttpError('ETIMEDOUT'));
    const a = telegramAdapter({ token: 't', allowlistChatIds: [12345] });
    const r = await a.send('telegram://12345', { text: 'hi' });
    expect(r).toEqual({ ok: false, error: 'network: ETIMEDOUT' });
  });

  it('falls back to String(e) for unknown error types', async () => {
    mockState.sendMessage.mockRejectedValueOnce(new Error('boom'));
    const a = telegramAdapter({ token: 't', allowlistChatIds: [12345] });
    const r = await a.send('telegram://12345', { text: 'hi' });
    expect(r).toEqual({ ok: false, error: 'boom' });
  });
});

describe('telegramAdapter — start()', () => {
  it('start() with outboundOnly=true no-ops; send still works', async () => {
    const a = telegramAdapter({ token: 't', allowlistChatIds: [12345], outboundOnly: true });
    await a.start();
    expect(mockState.start).not.toHaveBeenCalled();
    expect(mockState.deleteWebhook).not.toHaveBeenCalled();
    const r = await a.send('telegram://12345', { text: 'hi' });
    expect(r.ok).toBe(true);
  });

  it('start() calls deleteWebhook then bot.start() without awaiting', async () => {
    const a = telegramAdapter({ token: 't', allowlistChatIds: [12345] });
    await a.start();
    expect(mockState.deleteWebhook).toHaveBeenCalledTimes(1);
    expect(mockState.startCallCount).toBe(1);
  });

  it('start() is idempotent — second call is a no-op', async () => {
    const a = telegramAdapter({ token: 't', allowlistChatIds: [12345] });
    await a.start();
    await a.start();
    expect(mockState.startCallCount).toBe(1);
  });

  it('start() retries on 409 with exponential backoff', async () => {
    vi.useFakeTimers();
    // First start attempt rejects with 409; second hangs (success path).
    mockState.start.mockRejectedValueOnce(new FakeGrammyError(409, 'Conflict')).mockReturnValueOnce(
      new Promise<void>(() => {
        /* never resolves — bot.start() resolves on shutdown only */
      }),
    );
    const a = telegramAdapter({ token: 't', allowlistChatIds: [12345] });
    await a.start();
    // Let the rejected promise + scheduled setTimeout fire.
    await vi.runOnlyPendingTimersAsync();
    await vi.runOnlyPendingTimersAsync();
    expect(mockState.startCallCount).toBeGreaterThanOrEqual(2);
  });

  it('start() caps 409 retries at 5 then degrades to outbound-only', async () => {
    vi.useFakeTimers();
    mockState.start.mockRejectedValue(new FakeGrammyError(409, 'Conflict'));
    const a = telegramAdapter({ token: 't', allowlistChatIds: [12345] });
    await a.start();
    // Drain timer queue by repeatedly advancing.
    for (let i = 0; i < 10; i++) {
      await vi.runOnlyPendingTimersAsync();
    }
    // Initial attempt + 5 retries = 6 max.
    expect(mockState.startCallCount).toBeLessThanOrEqual(6);
    expect(mockState.startCallCount).toBeGreaterThanOrEqual(2);
    // Outbound still works after degradation.
    const r = await a.send('telegram://12345', { text: 'hi' });
    expect(r.ok).toBe(true);
  });

  it('start() does NOT retry on non-409 errors', async () => {
    vi.useFakeTimers();
    mockState.start.mockRejectedValueOnce(new FakeGrammyError(401, 'Unauthorized'));
    const a = telegramAdapter({ token: 't', allowlistChatIds: [12345] });
    await a.start();
    await vi.runOnlyPendingTimersAsync();
    await vi.runOnlyPendingTimersAsync();
    expect(mockState.startCallCount).toBe(1);
  });
});

describe('telegramAdapter — stop()', () => {
  it('stop() calls bot.stop() once', async () => {
    const a = telegramAdapter({ token: 't', allowlistChatIds: [12345] });
    await a.start();
    await a.stop();
    expect(mockState.stop).toHaveBeenCalledTimes(1);
  });

  it('stop() before start() is a no-op', async () => {
    const a = telegramAdapter({ token: 't', allowlistChatIds: [12345] });
    await a.stop();
    expect(mockState.stop).not.toHaveBeenCalled();
  });
});

describe('telegramAdapter — subscribeInbound (AUTO.6)', () => {
  it('emits InboundChannelEvent with channelUri from chat.id (no topic)', async () => {
    const events: unknown[] = [];
    const a = telegramAdapter({ token: 't', allowlistChatIds: [12345] });
    await a.subscribeInbound(async (e) => {
      events.push(e);
    });
    expect(mockState.messageListeners.length).toBe(1);

    await fireMessage({
      chat: { id: -100123 },
      from: { id: 8075471258 },
      message: { text: 'hello' },
    });
    expect(events).toHaveLength(1);
    const e = events[0] as { kind: string; channelUri: string; sender: string; text: string };
    expect(e.kind).toBe('inbound_channel');
    expect(e.channelUri).toBe('telegram://-100123');
    expect(e.sender).toBe('8075471258');
    expect(e.text).toBe('hello');
  });

  it('includes thread_id in channelUri + threadKey when message is in a forum topic', async () => {
    const events: unknown[] = [];
    const a = telegramAdapter({ token: 't', allowlistChatIds: [12345] });
    await a.subscribeInbound(async (e) => {
      events.push(e);
    });

    await fireMessage({
      chat: { id: -100123 },
      from: { id: 7 },
      message: { text: 'topic msg', message_thread_id: 42 },
    });
    const e = events[0] as { channelUri: string; threadKey?: string };
    expect(e.channelUri).toBe('telegram://-100123/42');
    expect(e.threadKey).toBe('42');
  });

  it('starts the bot lazily on subscribeInbound (long-polling kicks off)', async () => {
    const a = telegramAdapter({ token: 't', allowlistChatIds: [12345] });
    expect(mockState.startCallCount).toBe(0);
    await a.subscribeInbound(async () => Promise.resolve());
    expect(mockState.startCallCount).toBe(1);
  });

  it('subscribeInbound returns a stub when outboundOnly is true', async () => {
    const events: unknown[] = [];
    const a = telegramAdapter({
      token: 't',
      allowlistChatIds: [12345],
      outboundOnly: true,
    });
    const sub = await a.subscribeInbound(async (e) => {
      events.push(e);
    });
    // No listener attached, no start fired.
    expect(mockState.messageListeners).toHaveLength(0);
    expect(mockState.startCallCount).toBe(0);
    // Unsubscribe is a no-op.
    await sub.unsubscribe();
  });

  it('unsubscribe stops further events from firing the handler', async () => {
    const events: unknown[] = [];
    const a = telegramAdapter({ token: 't', allowlistChatIds: [12345] });
    const sub = await a.subscribeInbound(async (e) => {
      events.push(e);
    });
    await fireMessage({
      chat: { id: -1 },
      from: { id: 1 },
      message: { text: 'first' },
    });
    expect(events).toHaveLength(1);

    await sub.unsubscribe();
    await fireMessage({
      chat: { id: -1 },
      from: { id: 1 },
      message: { text: 'second' },
    });
    // Listener slot disabled — no new dispatch.
    expect(events).toHaveLength(1);
  });

  it('handler errors are swallowed and never bubble to the bot loop', async () => {
    const a = telegramAdapter({ token: 't', allowlistChatIds: [12345] });
    await a.subscribeInbound(async () => {
      throw new Error('handler boom');
    });
    // fireMessage runs `await l(ctx)` — if the adapter let the error
    // escape, this test would reject. Asserting "did not throw" is enough.
    await expect(
      fireMessage({
        chat: { id: -1 },
        from: { id: 1 },
        message: { text: 'x' },
      }),
    ).resolves.toBeUndefined();
  });
});

describe('telegramAdapter — subscribeTransport (CAT.1b rich envelope)', () => {
  it('emits the full InboundChatMessage with every field populated', async () => {
    const msgs: unknown[] = [];
    const a = telegramAdapter({ token: 't', allowlistChatIds: [12345], botUsername: 'squidbot' });
    await a.subscribeTransport(async (m) => {
      msgs.push(m);
    });
    await fireMessage({
      chat: { id: -1003923174632, type: 'supergroup' },
      from: { id: 8075471258, username: 'L0g1cProphet', first_name: 'S' },
      message: { message_id: 510, date: 1764649200, text: 'hello @SquidBot', message_thread_id: 15 },
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({
      platform: 'telegram',
      messageId: '510',
      chatId: '-1003923174632',
      topicId: 15,
      sender: 'L0g1cProphet',
      senderId: '8075471258',
      text: 'hello @SquidBot',
      receivedAt: new Date(1764649200 * 1000).toISOString(),
      mentionsBot: true, // @SquidBot matches botUsername 'squidbot' case-insensitively
      direct: false,
    });
  });

  it('marks direct=true for a private chat (chat.id === from.id)', async () => {
    const msgs: { direct: boolean }[] = [];
    const a = telegramAdapter({ token: 't', allowlistChatIds: [1] });
    await a.subscribeTransport(async (m) => {
      msgs.push(m);
    });
    await fireMessage({
      chat: { id: 8075471258, type: 'private' },
      from: { id: 8075471258, first_name: 'S' },
      message: { message_id: 1, text: 'dm' },
    });
    expect(msgs[0]?.direct).toBe(true);
  });

  it('mentionsBot is false when botUsername is unset', async () => {
    const msgs: { mentionsBot: boolean }[] = [];
    const a = telegramAdapter({ token: 't', allowlistChatIds: [1] });
    await a.subscribeTransport(async (m) => {
      msgs.push(m);
    });
    await fireMessage({
      chat: { id: -1, type: 'supergroup' },
      from: { id: 2 },
      message: { message_id: 1, text: '@anyone' },
    });
    expect(msgs[0]?.mentionsBot).toBe(false);
  });

  it('feeds BOTH transport + inbound from a single middleware (one bot.on)', async () => {
    const transport: unknown[] = [];
    const inbound: unknown[] = [];
    const a = telegramAdapter({ token: 't', allowlistChatIds: [1] });
    await a.subscribeTransport(async (m) => {
      transport.push(m);
    });
    await a.subscribeInbound(async (e) => {
      inbound.push(e);
    });
    // Only one grammy message listener is ever installed.
    expect(mockState.messageListeners).toHaveLength(1);
    await fireMessage({
      chat: { id: -5, type: 'supergroup' },
      from: { id: 9 },
      message: { message_id: 3, text: 'both' },
    });
    expect(transport).toHaveLength(1);
    expect(inbound).toHaveLength(1);
  });

  it('returns a stub (no listener, no start) when outboundOnly is true', async () => {
    const a = telegramAdapter({ token: 't', allowlistChatIds: [1], outboundOnly: true });
    const sub = await a.subscribeTransport(async () => Promise.resolve());
    expect(mockState.messageListeners).toHaveLength(0);
    expect(mockState.startCallCount).toBe(0);
    await sub.unsubscribe();
  });

  it('unsubscribe stops further transport dispatch', async () => {
    const msgs: unknown[] = [];
    const a = telegramAdapter({ token: 't', allowlistChatIds: [1] });
    const sub = await a.subscribeTransport(async (m) => {
      msgs.push(m);
    });
    await fireMessage({ chat: { id: -1, type: 'supergroup' }, from: { id: 1 }, message: { message_id: 1, text: 'a' } });
    expect(msgs).toHaveLength(1);
    await sub.unsubscribe();
    await fireMessage({ chat: { id: -1, type: 'supergroup' }, from: { id: 1 }, message: { message_id: 2, text: 'b' } });
    expect(msgs).toHaveLength(1);
  });
});
