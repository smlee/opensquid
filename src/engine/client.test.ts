/**
 * EngineClient socket-transport + JSON-RPC tests.
 *
 * Strategy: mock `./singleton.js` so we drive the engine connection
 * deterministically — no real engine binary or filesystem socket
 * required for the fast suite (a live-binary smoke test lives in
 * `client.live.test.ts`).
 *
 * Covers (T.4 acceptance criteria — refactored from T.2 stdio tests):
 *  - happy-path ping resolves
 *  - all 5 custom error codes surface as RpcError with code + data
 *  - mid-call socket close rejects pending calls
 *  - reconnects after daemon restart (`onClose` + next call re-acquires)
 *  - `spawnedByUs` flag flows through from singleton to client
 *  - `close()` ends the socket but does NOT kill the daemon
 */

import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockAcquireOrSpawnEngine = vi.fn();
vi.mock('./singleton.js', () => ({
  acquireOrSpawnEngine: (): unknown => mockAcquireOrSpawnEngine(),
}));

// vi.mock applies at hoist; dynamic import locks in ordering.
const { EngineClient, ENGINE_ERROR, RpcError } = await import('./client.js');

/**
 * Mock socket: extends `PassThrough` so it satisfies the `Socket`-
 * shaped surface that `EngineClient` needs (readline reads from it as
 * a Readable, the client writes JSON-RPC frames as a Writable, and
 * the `close`/`error` events come for free from `Duplex`).
 *
 * The client also writes outgoing frames into the same stream — so
 * we capture them via a separate PassThrough exposed as `out` (the
 * client's `write` is monkey-patched in `makeMockSocket` to route to
 * `out`). `writeServer()` writes responses directly into the
 * underlying PassThrough (the client's read side).
 */
interface MockSocket extends PassThrough {
  /** Captures what the client writes out (toward the engine). */
  out: PassThrough;
  /** Synthesize a JSON-RPC response line from the engine side. */
  writeServer: (line: string) => void;
}

function makeMockSocket(): MockSocket {
  const sock = new PassThrough() as MockSocket;
  sock.out = new PassThrough();
  // Capture the original write so writeServer can synthesize engine
  // responses without re-entering our override.
  const origWrite = sock.write.bind(sock);
  // Override `write` so the client's outgoing JSON frames go into
  // `out` instead of looping back into our own readable side.
  sock.write = (chunk: unknown): boolean => {
    // PassThrough.write accepts string | Uint8Array — no cast needed.
    sock.out.write(chunk);
    return true;
  };
  // `end()` should emit `close` so the lifecycle test sees it.
  sock.end = (): MockSocket => {
    setImmediate(() => sock.emit('close'));
    return sock;
  };
  sock.writeServer = (line: string): void => {
    origWrite(line);
  };
  return sock;
}

/** Resolves with the next full line written to the client's outgoing stream. */
function nextLine(stream: PassThrough): Promise<string> {
  return new Promise((resolve) => {
    let buf = '';
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        stream.off('data', onData);
        resolve(buf.slice(0, nl));
      }
    };
    stream.on('data', onData);
  });
}

beforeEach(() => {
  mockAcquireOrSpawnEngine.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Helper: ack the engine's startup ping then ack the user's own call.
 * The transport sends an internal `ping` to confirm liveness on first
 * use, so every user-initiated call writes two requests on a fresh
 * connection: id=1 (startup ping) + id=2 (user call).
 */
async function ackStartupAndUserCall(
  sock: MockSocket,
  expectedUserMethod: string,
  userResult: unknown,
): Promise<void> {
  const startupLine = await nextLine(sock.out);
  const startupReq = JSON.parse(startupLine) as { id: number; method: string };
  expect(startupReq.method).toBe('ping');
  sock.writeServer(
    JSON.stringify({
      jsonrpc: '2.0',
      id: startupReq.id,
      result: { ok: true, version: '0.5.4' },
    }) + '\n',
  );
  const userLine = await nextLine(sock.out);
  const userReq = JSON.parse(userLine) as { id: number; method: string };
  expect(userReq.method).toBe(expectedUserMethod);
  sock.writeServer(JSON.stringify({ jsonrpc: '2.0', id: userReq.id, result: userResult }) + '\n');
}

describe('EngineClient — singleton handshake + spawnedByUs flag', () => {
  it('calls acquireOrSpawnEngine and pings on first use', async () => {
    const sock = makeMockSocket();
    mockAcquireOrSpawnEngine.mockResolvedValueOnce({ socket: sock, spawnedByUs: true });

    const engine = new EngineClient();
    const pingP = engine.ping();

    await ackStartupAndUserCall(sock, 'ping', { ok: true, version: '0.5.4' });

    await expect(pingP).resolves.toEqual({ ok: true, version: '0.5.4' });
    expect(mockAcquireOrSpawnEngine).toHaveBeenCalledTimes(1);
    expect(engine.didSpawnEngine).toBe(true);
  });

  it('surfaces spawnedByUs=false when the daemon was already running', async () => {
    const sock = makeMockSocket();
    mockAcquireOrSpawnEngine.mockResolvedValueOnce({ socket: sock, spawnedByUs: false });

    const engine = new EngineClient();
    const pingP = engine.ping();
    await ackStartupAndUserCall(sock, 'ping', { ok: true, version: '0.5.4' });
    await pingP;

    expect(engine.didSpawnEngine).toBe(false);
  });
});

describe('EngineClient — RpcError surface (all 5 custom codes)', () => {
  async function ackStartup(sock: MockSocket): Promise<void> {
    const line = await nextLine(sock.out);
    const req = JSON.parse(line) as { id: number };
    sock.writeServer(
      JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { ok: true, version: '0.5.4' } }) + '\n',
    );
  }

  async function expectError<T extends { code: number; data?: unknown }>(
    code: number,
    message: string,
    data: T['data'],
  ): Promise<void> {
    const sock = makeMockSocket();
    mockAcquireOrSpawnEngine.mockResolvedValueOnce({ socket: sock, spawnedByUs: true });
    const engine = new EngineClient();

    const callP = engine.call('lesson.promote', { id: 'les-xyz' });
    await ackStartup(sock);

    const userLine = await nextLine(sock.out);
    const userReq = JSON.parse(userLine) as { id: number };
    sock.writeServer(
      JSON.stringify({
        jsonrpc: '2.0',
        id: userReq.id,
        error: { code, message, data },
      }) + '\n',
    );

    await expect(callP).rejects.toBeInstanceOf(RpcError);
    await callP.catch((e: unknown) => {
      const rpc = e as InstanceType<typeof RpcError>;
      expect(rpc.code).toBe(code);
      expect(rpc.data).toEqual(data);
      expect(rpc.message).toBe(message);
    });
  }

  it('PROMOTION_BLOCKED (-32000) carries reasons[]', async () => {
    await expectError(ENGINE_ERROR.PROMOTION_BLOCKED, 'promotion blocked', {
      reasons: ['missing-external-signal-sources', 'time-floor: age=0s < required=86400s'],
    });
  });

  it('USER_LESSON_IMMUNE (-32001) carries lesson_id', async () => {
    await expectError(ENGINE_ERROR.USER_LESSON_IMMUNE, 'user-authored lesson is eviction-immune', {
      lesson_id: 'les-abc12345',
    });
  });

  it('NOT_FOUND (-32002) carries id', async () => {
    await expectError(ENGINE_ERROR.NOT_FOUND, 'not found', { id: 'les-missing' });
  });

  it('USER_MEMORY_IMMUNE (-32003) carries memory_id + cited_by', async () => {
    await expectError(ENGINE_ERROR.USER_MEMORY_IMMUNE, 'user-cited memory is eviction-immune', {
      memory_id: 'mem-abc',
      cited_by: 3,
    });
  });

  it('SUPERSEDE_BLOCKED (-32004) carries reason', async () => {
    await expectError(ENGINE_ERROR.SUPERSEDE_BLOCKED, 'supersede blocked', {
      reason: 'self-reference',
    });
  });

  it('exports the standard JSON-RPC codes alongside engine-custom codes', () => {
    expect(ENGINE_ERROR.PARSE).toBe(-32700);
    expect(ENGINE_ERROR.INVALID_REQUEST).toBe(-32600);
    expect(ENGINE_ERROR.METHOD_NOT_FOUND).toBe(-32601);
    expect(ENGINE_ERROR.INVALID_PARAMS).toBe(-32602);
    expect(ENGINE_ERROR.INTERNAL).toBe(-32603);
  });
});

describe('EngineClient — connection lifecycle', () => {
  it('rejects in-flight pending calls when the socket closes mid-call', async () => {
    const sock = makeMockSocket();
    mockAcquireOrSpawnEngine.mockResolvedValueOnce({ socket: sock, spawnedByUs: true });
    const engine = new EngineClient();
    const callP = engine.call('task.example', {});

    // Ack startup ping, drain the user-call line, then close the socket.
    const startupLine = await nextLine(sock.out);
    const startupReq = JSON.parse(startupLine) as { id: number };
    sock.writeServer(
      JSON.stringify({ jsonrpc: '2.0', id: startupReq.id, result: { ok: true } }) + '\n',
    );
    await nextLine(sock.out); // drain user call

    sock.emit('close');

    await expect(callP).rejects.toThrow(/loop-engine connection lost/);
  });

  it('reconnects after the daemon socket closes (transparent restart)', async () => {
    const sock1 = makeMockSocket();
    const sock2 = makeMockSocket();
    mockAcquireOrSpawnEngine
      .mockResolvedValueOnce({ socket: sock1, spawnedByUs: true })
      .mockResolvedValueOnce({ socket: sock2, spawnedByUs: false });

    const engine = new EngineClient();
    const callP1 = engine.call<{ ok: true }>('task.example', {});

    // Drain sock1 startup ping + user call.
    const startupLine = await nextLine(sock1.out);
    const startupReq = JSON.parse(startupLine) as { id: number };
    sock1.writeServer(
      JSON.stringify({ jsonrpc: '2.0', id: startupReq.id, result: { ok: true } }) + '\n',
    );
    const userLine = await nextLine(sock1.out);
    const userReq = JSON.parse(userLine) as { id: number; method: string };
    expect(userReq.method).toBe('task.example');
    sock1.writeServer(
      JSON.stringify({ jsonrpc: '2.0', id: userReq.id, result: { ok: true } }) + '\n',
    );
    await expect(callP1).resolves.toEqual({ ok: true });

    // Simulate the daemon restarting — socket closes out-of-band.
    sock1.emit('close');
    await new Promise((r) => setImmediate(r));

    const callP2 = engine.call<{ ok: true }>('task.example', {});
    const startup2Line = await nextLine(sock2.out);
    const startup2Req = JSON.parse(startup2Line) as { id: number; method: string };
    expect(startup2Req.method).toBe('ping');
    sock2.writeServer(
      JSON.stringify({ jsonrpc: '2.0', id: startup2Req.id, result: { ok: true } }) + '\n',
    );
    const userLine2 = await nextLine(sock2.out);
    const userReq2 = JSON.parse(userLine2) as { id: number };
    sock2.writeServer(
      JSON.stringify({ jsonrpc: '2.0', id: userReq2.id, result: { ok: true } }) + '\n',
    );

    await expect(callP2).resolves.toEqual({ ok: true });
    expect(mockAcquireOrSpawnEngine).toHaveBeenCalledTimes(2);
  });
});

describe('EngineClient — close() ends connection without killing daemon', () => {
  it('end()s the socket and resolves on close, never kills the daemon', async () => {
    const sock = makeMockSocket();
    const killSpy = vi.fn();
    // Attach a kill spy — close() must NOT invoke it (engine lifecycle
    // is now owned by singleton.ts, not the client).
    (sock as unknown as { kill: typeof killSpy }).kill = killSpy;
    mockAcquireOrSpawnEngine.mockResolvedValueOnce({ socket: sock, spawnedByUs: true });

    const engine = new EngineClient();
    const pingP = engine.ping();
    await ackStartupAndUserCall(sock, 'ping', { ok: true, version: '0.5.4' });
    await pingP;

    const closeP = engine.close();
    // Microtask flush so close() registers its once('close') handler.
    await Promise.resolve();
    // No kill — engine stays running for the next session.
    expect(killSpy).not.toHaveBeenCalled();
    // end() triggers the synthetic 'close' event in our mock.
    await expect(closeP).resolves.toBeUndefined();
  });

  it('close() is a no-op when no connection was established', async () => {
    const engine = new EngineClient();
    await expect(engine.close()).resolves.toBeUndefined();
    expect(mockAcquireOrSpawnEngine).not.toHaveBeenCalled();
  });
});
