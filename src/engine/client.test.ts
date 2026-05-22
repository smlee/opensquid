/**
 * EngineClient subprocess + JSON-RPC tests.
 *
 * Strategy: mock `node:child_process` so we drive the subprocess
 * lifecycle deterministically — no real engine binary required for the
 * fast suite (a live-binary smoke test lives in `client.live.test.ts`).
 *
 * Covers (T.2 acceptance criteria):
 *  - happy-path ping resolves
 *  - all 5 custom error codes surface as RpcError with code + data
 *  - mid-call subprocess exit rejects pending calls
 *  - stderr noise emitted BEFORE first JSON-RPC stdout doesn't break parse
 *  - LOOP_HOME pin in spawn env (regression guard for T.1.D)
 *  - SIGTERM → SIGKILL escalation on close()
 *  - subprocess respawns after external exit (#170)
 */

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]): unknown => mockSpawn(...args),
}));

// vi.mock applies at hoist; dynamic import locks in ordering.
const { EngineClient, ENGINE_ERROR, RpcError } = await import('./client.js');

interface MockProc extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
}

function makeMockProc(): MockProc {
  const proc = new EventEmitter() as MockProc;
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  return proc;
}

/** Resolves with the next full line written to a stream. */
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
  mockSpawn.mockReset();
  process.env.OPENSQUID_ENGINE_BIN = '/fake/path/loop-engine';
});

afterEach(() => {
  delete process.env.OPENSQUID_ENGINE_BIN;
  vi.useRealTimers();
});

/**
 * Helper: ack the engine's startup ping then ack the user's own call.
 * The transport sends an internal `ping` to confirm liveness on first
 * use, so every user-initiated call writes two requests on a fresh
 * subprocess: id=1 (startup ping) + id=2 (user call).
 */
async function ackStartupAndUserCall(
  proc: MockProc,
  expectedUserMethod: string,
  userResult: unknown,
): Promise<void> {
  const startupLine = await nextLine(proc.stdin);
  const startupReq = JSON.parse(startupLine) as { id: number; method: string };
  expect(startupReq.method).toBe('ping');
  proc.stdout.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: startupReq.id,
      result: { ok: true, version: '0.5.3' },
    }) + '\n',
  );
  const userLine = await nextLine(proc.stdin);
  const userReq = JSON.parse(userLine) as { id: number; method: string };
  expect(userReq.method).toBe(expectedUserMethod);
  proc.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: userReq.id, result: userResult }) + '\n');
}

describe('EngineClient — startup ping + LOOP_HOME pin', () => {
  it('spawns with serve arg and LOOP_HOME pinned to ~/.opensquid', async () => {
    const proc = makeMockProc();
    mockSpawn.mockReturnValueOnce(proc);

    const engine = new EngineClient();
    const pingP = engine.ping();

    // First call sends startup ping (id=1) + user ping (id=2).
    await ackStartupAndUserCall(proc, 'ping', { ok: true, version: '0.5.3' });

    await expect(pingP).resolves.toEqual({ ok: true, version: '0.5.3' });

    // T.1.D regression guard — spawn env MUST include LOOP_HOME pin.
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const callArgs = mockSpawn.mock.calls[0] as [string, string[], { env: Record<string, string> }];
    expect(callArgs[0]).toBe('/fake/path/loop-engine');
    expect(callArgs[1]).toEqual(['serve']);
    expect(callArgs[2].env.LOOP_HOME).toBe(`${process.env.HOME ?? ''}/.opensquid`);
  });

  it('honors an externally-set LOOP_HOME instead of overwriting it', async () => {
    process.env.LOOP_HOME = '/tmp/loop-isolated-test';
    try {
      const proc = makeMockProc();
      mockSpawn.mockReturnValueOnce(proc);
      const engine = new EngineClient();
      const pingP = engine.ping();
      await ackStartupAndUserCall(proc, 'ping', { ok: true, version: '0.5.3' });
      await pingP;

      const callArgs = mockSpawn.mock.calls[0] as [
        string,
        string[],
        { env: Record<string, string> },
      ];
      expect(callArgs[2].env.LOOP_HOME).toBe('/tmp/loop-isolated-test');
    } finally {
      delete process.env.LOOP_HOME;
    }
  });
});

describe('EngineClient — RpcError surface (all 5 custom codes)', () => {
  async function ackStartup(proc: MockProc): Promise<void> {
    const line = await nextLine(proc.stdin);
    const req = JSON.parse(line) as { id: number };
    proc.stdout.write(
      JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { ok: true, version: '0.5.3' } }) + '\n',
    );
  }

  async function expectError<T extends { code: number; data?: unknown }>(
    code: number,
    message: string,
    data: T['data'],
  ): Promise<void> {
    const proc = makeMockProc();
    mockSpawn.mockReturnValueOnce(proc);
    const engine = new EngineClient();

    // Kick a call that triggers startup. Use a no-op method name; the
    // mock engine echoes whatever response we write back.
    const callP = engine.call('lesson.promote', { id: 'les-xyz' });
    await ackStartup(proc);

    const userLine = await nextLine(proc.stdin);
    const userReq = JSON.parse(userLine) as { id: number };
    proc.stdout.write(
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

describe('EngineClient — subprocess lifecycle', () => {
  it('tolerates stderr noise emitted before the first stdout response', async () => {
    const proc = makeMockProc();
    mockSpawn.mockReturnValueOnce(proc);
    const engine = new EngineClient();
    const pingP = engine.ping();

    // Engine emits 2 stderr lines (rehydrate stats + ready) before ANY
    // stdout. The client's stderr `data` handler must consume them
    // without affecting stdout parsing.
    proc.stderr.write(
      Buffer.from(
        '[loop-engine serve] rehydrated 38 memories (scanned 38, skipped 0 missing-vec, 0 parse-err)\n',
      ),
    );
    proc.stderr.write(
      Buffer.from('[loop-engine serve] ready on stdio (lessons: create/recall/...)\n'),
    );

    await ackStartupAndUserCall(proc, 'ping', { ok: true, version: '0.5.3' });

    await expect(pingP).resolves.toEqual({ ok: true, version: '0.5.3' });
  });

  it('rejects in-flight pending calls when the subprocess exits mid-call', async () => {
    const proc = makeMockProc();
    mockSpawn.mockReturnValueOnce(proc);
    const engine = new EngineClient();
    const callP = engine.call('task.example', {});

    // Ack startup ping, drain the user-call line, then crash.
    const startupLine = await nextLine(proc.stdin);
    const startupReq = JSON.parse(startupLine) as { id: number };
    proc.stdout.write(
      JSON.stringify({ jsonrpc: '2.0', id: startupReq.id, result: { ok: true } }) + '\n',
    );
    await nextLine(proc.stdin); // drain user call

    proc.emit('exit', null);

    await expect(callP).rejects.toThrow(/loop-engine subprocess exited/);
  });

  it('respawns the subprocess after an external exit (#170)', async () => {
    const proc1 = makeMockProc();
    const proc2 = makeMockProc();
    mockSpawn.mockReturnValueOnce(proc1).mockReturnValueOnce(proc2);

    const engine = new EngineClient();
    const callP1 = engine.call<{ ok: true }>('task.example', {});

    // Drain proc1 startup ping + user call.
    const startupLine = await nextLine(proc1.stdin);
    const startupReq = JSON.parse(startupLine) as { id: number };
    proc1.stdout.write(
      JSON.stringify({ jsonrpc: '2.0', id: startupReq.id, result: { ok: true } }) + '\n',
    );
    const userLine = await nextLine(proc1.stdin);
    const userReq = JSON.parse(userLine) as { id: number; method: string };
    expect(userReq.method).toBe('task.example');
    proc1.stdout.write(
      JSON.stringify({ jsonrpc: '2.0', id: userReq.id, result: { ok: true } }) + '\n',
    );
    await expect(callP1).resolves.toEqual({ ok: true });

    // Simulate external exit — pre-#170 would leave startupAck cached
    // and the next call would reject "engine subprocess not running".
    proc1.emit('exit', 1);
    await new Promise((r) => setImmediate(r));

    const callP2 = engine.call<{ ok: true }>('task.example', {});
    const startup2Line = await nextLine(proc2.stdin);
    const startup2Req = JSON.parse(startup2Line) as { id: number; method: string };
    expect(startup2Req.method).toBe('ping');
    proc2.stdout.write(
      JSON.stringify({ jsonrpc: '2.0', id: startup2Req.id, result: { ok: true } }) + '\n',
    );
    const userLine2 = await nextLine(proc2.stdin);
    const userReq2 = JSON.parse(userLine2) as { id: number };
    proc2.stdout.write(
      JSON.stringify({ jsonrpc: '2.0', id: userReq2.id, result: { ok: true } }) + '\n',
    );

    await expect(callP2).resolves.toEqual({ ok: true });
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });
});

describe('EngineClient — close() SIGTERM → SIGKILL escalation', () => {
  it('sends SIGTERM, escalates to SIGKILL after 2s, resolves on exit', async () => {
    const proc = makeMockProc();
    mockSpawn.mockReturnValueOnce(proc);
    const engine = new EngineClient();
    const pingP = engine.ping();
    await ackStartupAndUserCall(proc, 'ping', { ok: true, version: '0.5.3' });
    await pingP;

    // Switch to fake timers AFTER startup so real socket / readline
    // microtasks aren't trapped by the fake-timer queue.
    vi.useFakeTimers();
    const closeP = engine.close();
    // Microtask flush so close() registers its setTimeout + once('exit').
    await Promise.resolve();
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');

    // Advance fake timers past 2s — should fire the SIGKILL escalation.
    vi.advanceTimersByTime(2000);
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');

    // Now simulate the proc actually exiting; close() should resolve.
    proc.emit('exit', 0);
    await expect(closeP).resolves.toBeUndefined();
  });

  it('close() is a no-op when the subprocess never started', async () => {
    const engine = new EngineClient();
    await expect(engine.close()).resolves.toBeUndefined();
  });
});
