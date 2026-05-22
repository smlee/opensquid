/**
 * Daemon-singleton unit tests.
 *
 * Coverage per T.4 spec:
 *  - Cold start (no socket) → spawn returns `{spawnedByUs: true}`
 *  - Warm path (socket exists + alive) → connect returns `{spawnedByUs: false}`, no spawn
 *  - Stale socket (file present, no listener) → unlink + respawn
 *  - Concurrent acquire (Promise.all of 2 acquireOrSpawnEngine calls) → exactly one spawn
 *  - Windows platform guard → throws clear error
 *  - Socket path > 100 bytes → throws path-limit error
 *  - Pidfile written after spawn (T.7 dependency)
 *
 * Strategy: use a tempdir as `OPENSQUID_HOME` for path isolation, and
 * mock `node:child_process.spawn` + `node:net.connect` so we don't
 * touch the real engine binary or filesystem socket. The lock + path
 * + pidfile code paths run for real against the tempdir.
 */

import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mocks (must hoist before importing singleton) ------------------

const mockSpawn = vi.fn();
const mockConnect = vi.fn();
const mockResolveEngineBin = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]): unknown => mockSpawn(...args),
}));

vi.mock('node:net', () => ({
  connect: (...args: unknown[]): unknown => mockConnect(...args),
}));

vi.mock('./config.js', () => ({
  resolveEngineBin: (): Promise<string | null> => mockResolveEngineBin() as Promise<string | null>,
}));

const { acquireOrSpawnEngine, engineSocketPath, enginePidPath } = await import('./singleton.js');

// --- Test helpers ---------------------------------------------------

let tempHome: string;

/**
 * Mock socket — minimum interface for `tryConnect` (resolves on
 * 'connect' event, rejects on 'error', has `destroy()`).
 */
interface MockSocket extends EventEmitter {
  destroy: ReturnType<typeof vi.fn>;
  fakeConnect: () => void;
  fakeError: (err: Error) => void;
}

function makeMockSocket(): MockSocket {
  const sock = new EventEmitter() as MockSocket;
  sock.destroy = vi.fn();
  sock.fakeConnect = (): void => {
    // Emit asynchronously so the test code has a chance to attach
    // its `once('connect')` listener (matches real `net.connect`).
    setImmediate(() => sock.emit('connect'));
  };
  sock.fakeError = (err: Error): void => {
    setImmediate(() => sock.emit('error', err));
  };
  return sock;
}

/**
 * Mock spawned engine child. Tracks the pid + emits 'error' on
 * demand. Doesn't actually run anything.
 */
interface MockChildProc extends EventEmitter {
  pid: number;
  unref: ReturnType<typeof vi.fn>;
  stdin: null;
  stdout: null;
  stderr: null;
}

function makeMockProc(pid: number): MockChildProc {
  const proc = new EventEmitter() as MockChildProc;
  proc.pid = pid;
  proc.unref = vi.fn();
  proc.stdin = null;
  proc.stdout = null;
  proc.stderr = null;
  return proc;
}

beforeEach(() => {
  mockSpawn.mockReset();
  mockConnect.mockReset();
  mockResolveEngineBin.mockReset();
  tempHome = mkdtempSync(join(tmpdir(), 'opensquid-singleton-test-'));
  process.env.OPENSQUID_HOME = tempHome;
  // Default: binary resolves cleanly.
  mockResolveEngineBin.mockResolvedValue('/fake/path/loop-engine');
});

afterEach(() => {
  delete process.env.OPENSQUID_HOME;
  // Don't fail if tempdir contents include sockets — `force: true`.
  rmSync(tempHome, { recursive: true, force: true });
});

// --- Tests ----------------------------------------------------------

describe('acquireOrSpawnEngine — platform + path guards', () => {
  it('throws on Windows with a clear remediation message', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      await expect(acquireOrSpawnEngine()).rejects.toThrow(/Windows/);
      await expect(acquireOrSpawnEngine()).rejects.toThrow(/OPENSQUID_ENGINE_SOCKET=disable/);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });

  it('throws when the socket path exceeds the platform byte limit', async () => {
    // Pick a long path: 100-byte limit, so 120 bytes guarantees rejection.
    const longHome = join(tempHome, 'a'.repeat(120));
    process.env.OPENSQUID_HOME = longHome;
    await expect(acquireOrSpawnEngine()).rejects.toThrow(/exceeds 100-byte limit/);
  });
});

describe('acquireOrSpawnEngine — cold start (no socket)', () => {
  it('spawns the engine, writes the pidfile, and connects', async () => {
    const proc = makeMockProc(42424);
    // Spawn synthesizes the engine binding the socket file —
    // `waitForSocket` polls for its existence.
    mockSpawn.mockImplementationOnce(() => {
      writeFileSync(engineSocketPath(), '');
      return proc;
    });

    const sock = makeMockSocket();
    mockConnect.mockImplementationOnce(() => {
      sock.fakeConnect();
      return sock;
    });

    const result = await acquireOrSpawnEngine();
    expect(result.spawnedByUs).toBe(true);
    expect(result.socket).toBe(sock);

    // Spawn arg shape.
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const spawnArgs = mockSpawn.mock.calls[0] as [
      string,
      string[],
      { stdio: string[]; detached: boolean; env: Record<string, string> },
    ];
    expect(spawnArgs[0]).toBe('/fake/path/loop-engine');
    expect(spawnArgs[1]).toEqual(['serve', '--socket', engineSocketPath()]);
    // stdio: 'ignore' triple — load-bearing for detach.
    expect(spawnArgs[2].stdio).toEqual(['ignore', 'ignore', 'ignore']);
    expect(spawnArgs[2].detached).toBe(true);
    // LOOP_HOME pin.
    expect(spawnArgs[2].env.LOOP_HOME).toBeTruthy();
    // unref() called.
    expect(proc.unref).toHaveBeenCalledTimes(1);

    // Pidfile written.
    expect(existsSync(enginePidPath())).toBe(true);
    expect(readFileSync(enginePidPath(), 'utf8').trim()).toBe('42424');
  });

  it('throws a clear error when the engine binary cannot be resolved', async () => {
    mockResolveEngineBin.mockResolvedValueOnce(null);
    await expect(acquireOrSpawnEngine()).rejects.toThrow(/binary not found/);
  });

  it('surfaces spawn ENOENT as the actual cause instead of a socket-wait timeout', async () => {
    // T.8.A.03: spawn-time errors (binary missing / not executable)
    // previously only wrote to stderr, then `waitForSocket` rejected
    // ~10s later with a misleading "Timeout waiting for engine UDS at ..."
    // message. The fix captures the spawn error and re-throws it from
    // the waitForSocket catch path so callers see the real cause.
    //
    // We assert by catching the rejection ONCE and inspecting the
    // message — avoids the cost of two ~10s socket-wait timeouts.
    const proc = makeMockProc(33333);
    mockSpawn.mockImplementationOnce(() => {
      // Fire 'error' after a short delay so it lands AFTER the
      // production code has attached its `proc.once('error', ...)`
      // listener (which happens post-spawn, post-pidfile-write).
      // setImmediate fires too early — listener isn't attached yet
      // and Node treats the 'error' as unhandled.
      // Crucially: do NOT write the socket file — waitForSocket will
      // poll until its timeout and then throw, at which point our
      // catch should prefer the captured spawnErr.
      setTimeout(() => {
        const err = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
        proc.emit('error', err);
      }, 50);
      return proc;
    });

    let caught: Error | undefined;
    try {
      await acquireOrSpawnEngine();
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/spawn failed before socket appeared/);
    expect(caught!.message).toMatch(/ENOENT/);
  }, 15_000);
});

describe('acquireOrSpawnEngine — warm path (existing daemon)', () => {
  it('connects without spawning when the socket is alive', async () => {
    // Pre-create the socket file to simulate a running daemon.
    writeFileSync(engineSocketPath(), '');

    const sock = makeMockSocket();
    mockConnect.mockImplementationOnce(() => {
      sock.fakeConnect();
      return sock;
    });

    const result = await acquireOrSpawnEngine();
    expect(result.spawnedByUs).toBe(false);
    expect(result.socket).toBe(sock);
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});

describe('acquireOrSpawnEngine — stale socket path', () => {
  it('unlinks + respawns when the socket file is present but no listener answers', async () => {
    // Pre-create stale socket file.
    writeFileSync(engineSocketPath(), '');

    const staleSock = makeMockSocket();
    const liveSock = makeMockSocket();

    mockConnect
      // First connect (fast path): ECONNREFUSED → stale, unlink + fall through.
      .mockImplementationOnce(() => {
        staleSock.fakeError(Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }));
        return staleSock;
      })
      // Second connect (after spawn): success.
      .mockImplementationOnce(() => {
        liveSock.fakeConnect();
        return liveSock;
      });

    const proc = makeMockProc(55555);
    mockSpawn.mockImplementationOnce(() => {
      // Simulate engine re-creating the socket file after spawn.
      writeFileSync(engineSocketPath(), '');
      return proc;
    });

    const result = await acquireOrSpawnEngine();
    expect(result.spawnedByUs).toBe(true);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });
});

describe('acquireOrSpawnEngine — concurrent acquire', () => {
  it('spawns exactly one engine when two callers race', async () => {
    // No socket initially → cold path for both. The lock serializes.
    // The first acquirer spawns; the second sees the post-spawn socket
    // file during the recheck-after-lock step and connects warm.
    const proc = makeMockProc(77777);

    // Spawn fires once total. The mock both creates the socket file
    // (so the second acquirer's recheck passes) and returns a proc.
    mockSpawn.mockImplementationOnce(() => {
      writeFileSync(engineSocketPath(), '');
      return proc;
    });

    // Connect fires twice: first the post-spawn connect (spawnedByUs=true
    // path), then the second acquirer's warm-path connect.
    mockConnect.mockImplementation(() => {
      const sock = makeMockSocket();
      sock.fakeConnect();
      return sock;
    });

    const [a, b] = await Promise.all([acquireOrSpawnEngine(), acquireOrSpawnEngine()]);

    // Exactly one spawn across the two acquires.
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    // Exactly one of them spawned the engine.
    const spawnedCount = [a, b].filter((r) => r.spawnedByUs).length;
    expect(spawnedCount).toBe(1);
  });
});
