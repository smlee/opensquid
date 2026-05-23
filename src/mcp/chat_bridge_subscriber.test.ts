/**
 * chat_bridge_subscriber.ts unit tests — TPS.6 patch 3 (v0.5.127).
 *
 * Covers spec tests #13-#20 reduced to the subscriber-side
 * responsibilities. The chat_poll_inbox fs/buffer merge is exercised
 * via the buffer-drain API the handler calls; the handler itself is
 * tested in chat-bridge-server.test.ts (deferred to a follow-up).
 *
 * Strategy: inject a fake socket factory + fake setTimeout. No real
 * UDS. The fake socket records writes and exposes emit() for tests to
 * drive incoming bytes + lifecycle events.
 */

import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ChatBridgeSubscriber,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  SHUTDOWN_BACKOFF_MS,
  generateSessionId,
  type InboundMessage,
  type SubscriberOptions,
} from './chat_bridge_subscriber.js';

interface FakeSocket extends EventEmitter {
  writes: string[];
  destroyed: boolean;
  setEncoding(_enc: BufferEncoding): void;
  write(line: string): boolean;
  end(): void;
}

function makeFakeSocket(): FakeSocket {
  const sock = new EventEmitter() as FakeSocket;
  sock.writes = [];
  sock.destroyed = false;
  sock.setEncoding = (): void => undefined;
  sock.write = (line: string): boolean => {
    sock.writes.push(line);
    return true;
  };
  sock.end = (): void => {
    sock.destroyed = true;
    sock.emit('close');
  };
  return sock;
}

let timers: Array<{ cb: () => void; ms: number }> = [];
let createdSockets: FakeSocket[] = [];
let stderrCalls: string[];
let originalStderrWrite: typeof process.stderr.write;

beforeEach(() => {
  timers = [];
  createdSockets = [];
  stderrCalls = [];
  originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderrCalls.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stderr.write = originalStderrWrite;
});

function makeSubscriber(extra?: Partial<SubscriberOptions>): ChatBridgeSubscriber {
  return new ChatBridgeSubscriber({
    socketPath: '/tmp/fake.sock',
    sessionId: 'sess-test',
    workspaceUuid: 'uuid-w',
    workspacePath: '/x',
    chatIds: [],
    setTimeoutFn: (cb, ms) => {
      timers.push({ cb, ms });
      return undefined;
    },
    connectFn: () => {
      const sock = makeFakeSocket();
      createdSockets.push(sock);
      return sock as unknown as ReturnType<typeof import('node:net').connect>;
    },
    ...(extra ?? {}),
  });
}

function exampleNotification(overrides?: Partial<InboundMessage>): string {
  const params: InboundMessage = {
    delivery_id: 'd-1',
    message_id: 'm-1',
    platform: 'telegram',
    channel: 'telegram:-100',
    sender: 'alice',
    sender_id: '111',
    text: 'hi',
    received_at: '2026-05-23T19:00:00Z',
    mentions_bot: false,
    ...overrides,
  };
  return JSON.stringify({ jsonrpc: '2.0', method: 'inbound_message', params }) + '\n';
}

// ---------------------------------------------------------------------
// #13 Connect + subscribe on startup
// ---------------------------------------------------------------------

describe('ChatBridgeSubscriber — connect + subscribe', () => {
  it('13: opens UDS connection and writes a subscribe frame on connect', () => {
    const sub = makeSubscriber();
    sub.start();
    expect(createdSockets).toHaveLength(1);
    const sock = createdSockets[0]!;
    sock.emit('connect');
    expect(sock.writes).toHaveLength(1);
    const req = JSON.parse(sock.writes[0]!) as {
      method: string;
      params: { session_id: string; chat_ids: string[] };
    };
    expect(req.method).toBe('subscribe');
    expect(req.params.session_id).toBe('sess-test');
    expect(req.params.chat_ids).toEqual([]);
  });
});

// ---------------------------------------------------------------------
// #14 Reconnect on close
// ---------------------------------------------------------------------

describe('ChatBridgeSubscriber — reconnect', () => {
  it('14: schedules reconnect when socket closes', () => {
    const sub = makeSubscriber();
    sub.start();
    const sock = createdSockets[0]!;
    sock.emit('connect');
    sock.emit('close');
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(RECONNECT_BASE_MS);
    // Fire the timer.
    timers[0]!.cb();
    expect(createdSockets).toHaveLength(2);
  });

  it('15: exponential backoff capped at RECONNECT_MAX_MS', () => {
    const sub = makeSubscriber();
    sub.start();
    // Initial connect + a series of close → reconnect cycles.
    let attempt = 0;
    const expected = [
      RECONNECT_BASE_MS,
      RECONNECT_BASE_MS * 2,
      RECONNECT_BASE_MS * 4,
      RECONNECT_BASE_MS * 8,
      RECONNECT_BASE_MS * 16,
      RECONNECT_BASE_MS * 32,
      RECONNECT_MAX_MS, // capped
      RECONNECT_MAX_MS,
      RECONNECT_MAX_MS,
    ];
    for (const ms of expected) {
      const sock = createdSockets[attempt]!;
      // Don't emit 'connect' — that would reset backoff. Simulate
      // a connect-and-immediate-close (subscribe never gets to
      // succeed).
      sock.emit('close');
      const timer = timers[attempt];
      expect(timer).toBeDefined();
      expect(timer!.ms).toBe(ms);
      timer!.cb();
      attempt += 1;
    }
  });

  it('15b: successful subscribe resets backoff', () => {
    const sub = makeSubscriber();
    sub.start();
    const sock1 = createdSockets[0]!;
    sock1.emit('connect'); // resets backoff to BASE_MS via successful write
    sock1.emit('close');
    timers[0]!.cb();
    const sock2 = createdSockets[1]!;
    sock2.emit('connect'); // resets again
    sock2.emit('close');
    expect(timers[1]!.ms).toBe(RECONNECT_BASE_MS);
  });
});

// ---------------------------------------------------------------------
// #16 Buffer fill from notifications
// ---------------------------------------------------------------------

describe('ChatBridgeSubscriber — buffer fill', () => {
  it('16: incoming inbound_message frames populate the buffer', () => {
    const sub = makeSubscriber();
    sub.start();
    const sock = createdSockets[0]!;
    sock.emit('connect');
    sock.emit(
      'data',
      exampleNotification({ delivery_id: 'd-A', received_at: '2026-05-23T19:00:00Z' }),
    );
    sock.emit(
      'data',
      exampleNotification({ delivery_id: 'd-B', received_at: '2026-05-23T19:01:00Z' }),
    );
    sock.emit(
      'data',
      exampleNotification({ delivery_id: 'd-C', received_at: '2026-05-23T19:02:00Z' }),
    );
    expect(sub.bufferSize()).toBe(3);
    const all = sub.drainBuffer();
    expect(all.map((m) => m.delivery_id)).toEqual(['d-A', 'd-B', 'd-C']);
  });

  it('18: since cursor filters buffer drain', () => {
    const sub = makeSubscriber();
    sub.start();
    const sock = createdSockets[0]!;
    sock.emit('connect');
    sock.emit(
      'data',
      exampleNotification({ delivery_id: 'd-A', received_at: '2026-05-23T19:00:00Z' }),
    );
    sock.emit(
      'data',
      exampleNotification({ delivery_id: 'd-B', received_at: '2026-05-23T19:01:00Z' }),
    );
    sock.emit(
      'data',
      exampleNotification({ delivery_id: 'd-C', received_at: '2026-05-23T19:02:00Z' }),
    );
    const since = '2026-05-23T19:00:30Z';
    const filtered = sub.drainBuffer(since);
    expect(filtered.map((m) => m.delivery_id)).toEqual(['d-B', 'd-C']);
  });

  it('19: LRU eviction at bufferMax', () => {
    const sub = makeSubscriber({ bufferMax: 5 });
    sub.start();
    const sock = createdSockets[0]!;
    sock.emit('connect');
    for (let i = 0; i < 8; i++) {
      sock.emit(
        'data',
        exampleNotification({
          delivery_id: `d-${String(i)}`,
          received_at: `2026-05-23T19:00:0${String(i)}Z`,
        }),
      );
    }
    expect(sub.bufferSize()).toBe(5);
    const all = sub.drainBuffer();
    // Oldest 3 evicted.
    expect(all.map((m) => m.delivery_id)).toEqual(['d-3', 'd-4', 'd-5', 'd-6', 'd-7']);
  });

  it('handles multi-line frames in one data chunk', () => {
    const sub = makeSubscriber();
    sub.start();
    const sock = createdSockets[0]!;
    sock.emit('connect');
    const chunk =
      exampleNotification({ delivery_id: 'd-1', received_at: '2026-05-23T19:00:00Z' }) +
      exampleNotification({ delivery_id: 'd-2', received_at: '2026-05-23T19:01:00Z' });
    sock.emit('data', chunk);
    expect(sub.bufferSize()).toBe(2);
  });

  it('handles partial line spread across two data chunks', () => {
    const sub = makeSubscriber();
    sub.start();
    const sock = createdSockets[0]!;
    sock.emit('connect');
    const full = exampleNotification({ delivery_id: 'd-1', received_at: '2026-05-23T19:00:00Z' });
    const half = Math.floor(full.length / 2);
    sock.emit('data', full.slice(0, half));
    expect(sub.bufferSize()).toBe(0);
    sock.emit('data', full.slice(half));
    expect(sub.bufferSize()).toBe(1);
  });

  it('skips malformed JSON lines without crashing', () => {
    const sub = makeSubscriber();
    sub.start();
    const sock = createdSockets[0]!;
    sock.emit('connect');
    sock.emit('data', 'not json at all\n');
    sock.emit('data', exampleNotification({ delivery_id: 'd-ok' }));
    expect(sub.bufferSize()).toBe(1);
    expect(stderrCalls.some((c) => c.includes('malformed JSON'))).toBe(true);
  });

  it('daemon_shutdown notification lengthens next reconnect to SHUTDOWN_BACKOFF_MS', () => {
    const sub = makeSubscriber();
    sub.start();
    const sock = createdSockets[0]!;
    sock.emit('connect');
    sock.emit(
      'data',
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'daemon_shutdown',
        params: { reason: 'SIGTERM' },
      }) + '\n',
    );
    sock.emit('close');
    expect(timers[0]!.ms).toBeGreaterThanOrEqual(SHUTDOWN_BACKOFF_MS);
  });
});

// ---------------------------------------------------------------------
// generateSessionId
// ---------------------------------------------------------------------

describe('generateSessionId', () => {
  it('returns env override when set', () => {
    const prior = process.env.OPENSQUID_SESSION_ID;
    process.env.OPENSQUID_SESSION_ID = 'env-supplied-id';
    try {
      expect(generateSessionId()).toBe('env-supplied-id');
    } finally {
      if (prior === undefined) delete process.env.OPENSQUID_SESSION_ID;
      else process.env.OPENSQUID_SESSION_ID = prior;
    }
  });

  it('generates a uuid-shaped string when env unset', () => {
    const prior = process.env.OPENSQUID_SESSION_ID;
    delete process.env.OPENSQUID_SESSION_ID;
    try {
      const id = generateSessionId();
      expect(id).toMatch(/^mcp-[0-9a-f-]{36}$/);
    } finally {
      if (prior !== undefined) process.env.OPENSQUID_SESSION_ID = prior;
    }
  });
});
