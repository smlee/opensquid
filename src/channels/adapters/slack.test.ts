/**
 * Slack adapter tests — @slack/web-api + @slack/socket-mode mocked.
 * Covers URI validation, send happy path, send rejection mapping,
 * ack-within-3s on inbound (fake-timer asserted), inbound handler
 * runs AFTER ack, malformed URI rejection, and token-never-logged
 * discipline on error paths.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface MockWebState {
  postMessage: ReturnType<typeof vi.fn>;
  constructorToken: string | null;
  constructedCount: number;
}

interface MockSocketState {
  start: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  listeners: Map<string, ((envelope: unknown) => void | Promise<void>)[]>;
  constructedAppToken: string | null;
  constructedCount: number;
}

const web: MockWebState = {
  postMessage: vi.fn(),
  constructorToken: null,
  constructedCount: 0,
};

const socket: MockSocketState = {
  start: vi.fn(),
  disconnect: vi.fn(),
  listeners: new Map(),
  constructedAppToken: null,
  constructedCount: 0,
};

vi.mock('@slack/web-api', () => {
  class WebClient {
    chat = {
      postMessage: (args: { channel: string; text: string }): Promise<unknown> =>
        web.postMessage(args) as Promise<unknown>,
    };
    constructor(token: string) {
      web.constructorToken = token;
      web.constructedCount += 1;
    }
  }
  return { WebClient };
});

vi.mock('@slack/socket-mode', () => {
  class SocketModeClient {
    constructor(opts: { appToken: string }) {
      socket.constructedAppToken = opts.appToken;
      socket.constructedCount += 1;
    }
    on(event: string, listener: (envelope: unknown) => void | Promise<void>): void {
      const cur = socket.listeners.get(event) ?? [];
      cur.push(listener);
      socket.listeners.set(event, cur);
    }
    start(): Promise<unknown> {
      return socket.start() as Promise<unknown>;
    }
    disconnect(): Promise<unknown> {
      return socket.disconnect() as Promise<unknown>;
    }
  }
  return { SocketModeClient };
});

const { slackAdapter } = await import('./slack.js');

beforeEach(() => {
  web.postMessage.mockReset();
  web.constructorToken = null;
  web.constructedCount = 0;
  socket.start.mockReset();
  socket.disconnect.mockReset();
  socket.listeners = new Map();
  socket.constructedAppToken = null;
  socket.constructedCount = 0;
  web.postMessage.mockResolvedValue({ ok: true });
  socket.start.mockResolvedValue(undefined);
  socket.disconnect.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('slackAdapter — URI validation', () => {
  it('validates slack://<workspace>/<channel>', () => {
    const a = slackAdapter({ botToken: 'xoxb-bot', appToken: 'xapp-app' });
    expect(a.validate('slack://acme/general')).toBe(true);
    expect(a.validate('slack://acme-org/dev-alerts')).toBe(true);
    expect(a.validate('slack://acme')).toBe(false);
    expect(a.validate('slack://acme/')).toBe(false);
    expect(a.validate('slack://acme/general/extra')).toBe(false);
    expect(a.validate('slack://acme org/general')).toBe(false);
    expect(a.validate('discord://1/2')).toBe(false);
  });
});

describe('slackAdapter — send()', () => {
  it('posts to the channel parsed from the URI (happy path)', async () => {
    const a = slackAdapter({ botToken: 'xoxb-bot', appToken: 'xapp-app' });
    const r = await a.send('slack://acme/general', { text: 'hi team' });
    expect(r).toEqual({ ok: true });
    expect(web.postMessage).toHaveBeenCalledWith({ channel: 'general', text: 'hi team' });
    expect(web.constructorToken).toBe('xoxb-bot');
  });

  it('rejects malformed URI without calling postMessage', async () => {
    const a = slackAdapter({ botToken: 'xoxb-bot', appToken: 'xapp-app' });
    const r = await a.send('slack://acme', { text: 'x' });
    expect(r).toEqual({ ok: false, error: 'bad uri' });
    expect(web.postMessage).not.toHaveBeenCalled();
  });

  it('surfaces postMessage rejection and redacts tokens from error', async () => {
    web.postMessage.mockRejectedValueOnce(
      new Error('slack api boom; token xoxb-bot leaked; xapp-app too'),
    );
    const a = slackAdapter({ botToken: 'xoxb-bot', appToken: 'xapp-app' });
    const r = await a.send('slack://acme/general', { text: 'hi' });
    expect(r.ok).toBe(false);
    expect(r.error).toBeDefined();
    expect(r.error).not.toContain('xoxb-bot');
    expect(r.error).not.toContain('xapp-app');
    expect(r.error).toContain('[redacted]');
  });
});

describe('slackAdapter — inbound 3s ack SLA', () => {
  it('acks synchronously, then dispatches handler asynchronously', async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const onEvent = vi.fn(() => {
      order.push('handler');
    });
    const a = slackAdapter({ botToken: 'xoxb', appToken: 'xapp', onEvent });
    const ack = vi.fn(() => {
      order.push('ack');
    });
    // Synthetic envelope — adapter must call ack() before onEvent.
    await a.handleInbound({ type: 'app_mention', body: { foo: 1 }, ack });
    expect(ack).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledTimes(1);
    // ack fires first.
    expect(order[0]).toBe('ack');
    expect(order[1]).toBe('handler');
  });

  it('ack happens within 3 seconds even if handler is slow', async () => {
    vi.useFakeTimers();
    const ackTimes: number[] = [];
    const onEvent = vi.fn(async () => {
      // simulate slow handler — 10 seconds
      await new Promise((r) => setTimeout(r, 10_000));
    });
    const a = slackAdapter({ botToken: 'xoxb', appToken: 'xapp', onEvent });
    const start = Date.now();
    const ack = vi.fn(() => {
      ackTimes.push(Date.now() - start);
    });
    const p = a.handleInbound({ type: 'event', body: {}, ack });
    // Let microtasks run; ack must already have fired before any timers.
    await Promise.resolve();
    expect(ack).toHaveBeenCalledTimes(1);
    expect(ackTimes[0]).toBeLessThan(3000);
    // Now advance the slow handler timer to completion.
    await vi.advanceTimersByTimeAsync(10_000);
    await p;
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it('handler errors do not prevent ack', async () => {
    const ack = vi.fn();
    const onEvent = vi.fn(() => {
      throw new Error('handler boom');
    });
    const a = slackAdapter({ botToken: 'xoxb', appToken: 'xapp', onEvent });
    await a.handleInbound({ type: 'event', body: {}, ack });
    expect(ack).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledTimes(1);
  });
});

describe('slackAdapter — start()/stop() lifecycle', () => {
  it('start() is idempotent — second call is a no-op', async () => {
    const a = slackAdapter({ botToken: 'xoxb', appToken: 'xapp' });
    await a.start();
    await a.start();
    expect(web.constructedCount).toBe(1);
  });

  it('start() only attaches socket mode when onEvent is provided', async () => {
    const outboundOnly = slackAdapter({ botToken: 'xoxb', appToken: 'xapp' });
    await outboundOnly.start();
    expect(socket.constructedCount).toBe(0);

    const onEvent = vi.fn();
    const withInbound = slackAdapter({ botToken: 'xoxb', appToken: 'xapp', onEvent });
    await withInbound.start();
    expect(socket.constructedCount).toBe(1);
    expect(socket.constructedAppToken).toBe('xapp');
    await withInbound.stop();
  });

  it('stop() disconnects the socket and clears state', async () => {
    const a = slackAdapter({ botToken: 'xoxb', appToken: 'xapp', onEvent: vi.fn() });
    await a.start();
    await a.stop();
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
  });
});
