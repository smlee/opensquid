/**
 * Daemon-singleton acquire-or-spawn for the loop-engine UDS daemon.
 *
 * One engine process per host. All opensquid hooks + sessions share
 * the same engine over a Unix domain socket at
 * `~/.opensquid/loop-engine.sock`. This is the keystone for cross-
 * session memory recall — session A writes a memory, session B reads
 * it through the same engine without per-process spawn cost.
 *
 * Flow (per spec T.4 / audit T.1.Y + T.1.Z + T.1.BB + T.1.DD):
 *
 *  1. Windows guard — UDS is Unix-only; named-pipe support is a
 *     follow-up. Windows callers fall back to per-process stdio spawn
 *     by setting `OPENSQUID_ENGINE_SOCKET=disable` upstream.
 *
 *  2. Path-byte guard — macOS limits UDS paths to 104 bytes (Linux
 *     108). `~/.opensquid/loop-engine.sock` ≈ 30 chars on typical
 *     homes, but exotic `$HOME` values can exceed it. Refuse at 100
 *     to leave margin.
 *
 *  3. Fast path — if the socket file exists, try to connect. Success
 *     means an engine is already running; return the socket with
 *     `spawnedByUs: false`. ECONNREFUSED means the file is stale (a
 *     previous engine crashed without unlinking); unlink and fall
 *     through to the spawn path.
 *
 *  4. Slow path (lock + spawn):
 *     a. Touch `~/.opensquid/loop-engine.lock` so `proper-lockfile`
 *        has a stable inode to lock against.
 *     b. Acquire the lock with retry — serializes concurrent spawn
 *        attempts across multiple opensquid processes.
 *     c. RECHECK after the lock: another process may have spawned
 *        the engine while we waited. If yes, connect + return.
 *     d. Resolve the engine binary via existing `resolveEngineBin()`.
 *     e. Spawn detached + `stdio: 'ignore'` so the engine outlives
 *        the parent (true daemon semantics). `'inherit'` would hold
 *        the parent's stdout/stderr pipes open and block parent exit
 *        (per subprocess-lifecycle audit). Engine logs route to
 *        /dev/null in this mode; `RUST_LOG=...` + a redirect-to-file
 *        is the workaround if diagnostics are needed.
 *     f. Write `~/.opensquid/loop-engine.pid` with the spawned pid
 *        BEFORE `proc.unref()` so T.7's `engine kill` command can
 *        find it.
 *     g. `proc.unref()` — let the parent event loop exit without
 *        waiting on the engine.
 *     h. Wait for the socket file to appear (engine binds before
 *        accept; 10s budget covers cold-start HNSW rehydrate of
 *        ~76 memories on typical hardware).
 *     i. Connect; return with `spawnedByUs: true`.
 *
 *  5. Always release the lock in a `finally` block.
 *
 * NOT a singleton class — exported as a plain async function so
 * callers can compose / inject without instance state. Concurrency
 * safety lives in `proper-lockfile`, not in this module.
 */

import { existsSync } from 'node:fs';
import { open, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { connect, type Socket } from 'node:net';
import { join } from 'node:path';
import { homedir } from 'node:os';

import lockfile from 'proper-lockfile';

import { resolveEngineBin } from './config.js';

// ---- Constants -----------------------------------------------------

// Layout under `~/.opensquid/`. Keep all three colocated so cleanup
// scripts can `rm ~/.opensquid/loop-engine.*` without hunting.
const SOCK_FILENAME = 'loop-engine.sock';
const LOCK_FILENAME = 'loop-engine.lock';
const PID_FILENAME = 'loop-engine.pid';

/**
 * macOS sockaddr_un caps the path at 104 bytes; Linux at 108. We
 * guard at 100 to leave margin for either platform. Failure here is
 * fast + actionable — the alternative is a cryptic `ENAMETOOLONG`
 * from `bind(2)` deep inside engine startup.
 */
const SOCKET_PATH_BYTE_LIMIT = 100;

/**
 * Cold-start budget for the engine. Bind happens in <500ms cold, but
 * HNSW rehydrate of ~76 memories adds 1-3s on typical hardware.
 * 10s is forgiving without making real failure modes (missing
 * binary, wrong --socket path) feel slow.
 */
const SOCKET_WAIT_TIMEOUT_MS = 10_000;

const SOCKET_WAIT_POLL_INTERVAL_MS = 50;

// ---- Path helpers --------------------------------------------------

/** Engine socket path. Override `OPENSQUID_HOME` to relocate. */
export function engineSocketPath(): string {
  return join(opensquidHome(), SOCK_FILENAME);
}

/** Lock file used to serialize concurrent spawn attempts. */
export function engineLockPath(): string {
  return join(opensquidHome(), LOCK_FILENAME);
}

/**
 * Pidfile path used by `engine kill` (T.7). Written after spawn
 * returns, before `unref()`. Note: the engine process itself does
 * NOT manage this file — opensquid owns its lifecycle since opensquid
 * is the one that spawned the engine. T.7 will add a startup-time
 * cleanup hook for the spawned-by-us case.
 */
export function enginePidPath(): string {
  return join(opensquidHome(), PID_FILENAME);
}

function opensquidHome(): string {
  // Mirrors `OPENSQUID_HOME` resolution from runtime/paths.ts without
  // importing it (avoid cycles + keep this module's import surface
  // narrow). Override semantics: env wins → default `~/.opensquid`.
  const env = process.env.OPENSQUID_HOME?.trim();
  // `??` would let an empty-string env through; we want to fall back
  // on empty just like on undefined, so guard explicitly.
  return env && env.length > 0 ? env : join(homedir(), '.opensquid');
}

// ---- Public API ----------------------------------------------------

export interface EngineConnection {
  /** Connected socket to the engine's UDS endpoint. */
  socket: Socket;
  /**
   * `true` when this caller's invocation was the one that spawned the
   * engine process (cold start path). `false` when an existing engine
   * was found and connected to (warm path). Useful for telemetry +
   * test assertions; production callers usually ignore it.
   */
  spawnedByUs: boolean;
}

/**
 * Acquire a connection to the shared loop-engine daemon, spawning
 * one if none is running. Safe to call concurrently from multiple
 * processes — `proper-lockfile` serializes spawn attempts so only
 * one engine starts per `~/.opensquid/loop-engine.sock` lifetime.
 *
 * Throws on:
 *  - Windows (UDS unsupported; use stdio mode upstream)
 *  - socket path exceeds platform byte limit
 *  - engine binary not resolvable
 *  - socket never appears within `SOCKET_WAIT_TIMEOUT_MS`
 *  - underlying spawn / connect / lock errors
 */
export async function acquireOrSpawnEngine(): Promise<EngineConnection> {
  // Windows: UDS isn't supported (engine returns an error on this
  // path too). Throw clearly so callers can route around it rather
  // than failing deep in `net.connect`.
  if (process.platform === 'win32') {
    throw new Error(
      'UDS singleton not supported on Windows yet; ' +
        'set OPENSQUID_ENGINE_SOCKET=disable to fall back to per-process stdio spawn',
    );
  }

  const sockPath = engineSocketPath();
  if (Buffer.byteLength(sockPath, 'utf8') > SOCKET_PATH_BYTE_LIMIT) {
    throw new Error(
      `UDS path ${sockPath} exceeds ${SOCKET_PATH_BYTE_LIMIT}-byte limit ` +
        `(macOS=104, Linux=108). Move OPENSQUID_HOME to a shorter path.`,
    );
  }

  // Fast path: existing engine.
  if (existsSync(sockPath)) {
    const warm = await tryConnect(sockPath).catch(() => null);
    if (warm) {
      return { socket: warm, spawnedByUs: false };
    }
    // ECONNREFUSED → stale socket file. Drop it; fall through to
    // the lock + spawn path. Errors from unlink are swallowed (the
    // recheck-after-lock step will catch any residual state).
    await unlink(sockPath).catch(() => undefined);
  }

  // Slow path: serialize spawn attempts.
  await ensureOpensquidHome();
  const lockPath = engineLockPath();
  await touchFile(lockPath);

  const release = await lockfile.lock(lockPath, {
    realpath: false,
    retries: {
      retries: 5,
      factor: 2,
      minTimeout: 50,
      maxTimeout: 500,
    },
    // 10s stale-lock window — covers our 10s socket-wait + slack.
    // Without this, a crashed spawning-process would hold the lock
    // forever and every subsequent acquire would time out.
    stale: 10_000,
  });

  try {
    // RECHECK: another process may have raced past us between the
    // fast-path miss and the lock acquisition.
    if (existsSync(sockPath)) {
      const warm = await tryConnect(sockPath).catch(() => null);
      if (warm) {
        return { socket: warm, spawnedByUs: false };
      }
      await unlink(sockPath).catch(() => undefined);
    }

    const bin = await resolveEngineBin();
    if (!bin) {
      throw new Error(
        'loop-engine binary not found. Set OPENSQUID_ENGINE_BIN, run ' +
          '`opensquid engine set-path <path>`, or build at ' +
          '~/projects/loop/engine/target/release/loop-engine',
      );
    }

    // Detached + ignored stdio = true daemon. Both flags are
    // load-bearing:
    //  - `detached: true` puts the child in its own process group so
    //    it survives parent exit (Unix double-fork semantics).
    //  - `stdio: ['ignore', 'ignore', 'ignore']` closes the
    //    inherited stdio fds. `'inherit'` would hold the parent's
    //    stdout/stderr pipes open and block parent exit (e.g. the
    //    Node CLI would never return to the shell).
    //
    // Side effect: engine `tracing` output writes to /dev/null. If
    // diagnostics are needed, set `RUST_LOG` AND redirect engine
    // stderr to a file via a wrapper script — opensquid does not
    // own that policy.
    const proc = spawn(bin, ['serve', '--socket', sockPath], {
      stdio: ['ignore', 'ignore', 'ignore'],
      env: {
        ...process.env,
        // Pin the engine's storage root to ~/.opensquid (T.1.D regression
        // guard). Engine defaults to ~/.loop; without this pin, memories +
        // lessons written via opensquid would be invisible to subsequent
        // engine reads.
        LOOP_HOME: process.env.LOOP_HOME ?? join(homedir(), '.opensquid'),
      },
      detached: true,
    });

    // Pidfile write BEFORE `unref()` so T.7's `engine kill` can find
    // the pid even if the spawning Node process exits immediately.
    // Best-effort: a pidfile-write failure shouldn't tank the
    // acquire (T.7 falls back to `pgrep` if the pidfile is missing).
    if (proc.pid !== undefined) {
      await writeFile(enginePidPath(), `${String(proc.pid)}\n`, 'utf8').catch((e: unknown) => {
        process.stderr.write(`[opensquid] warning: failed to write engine pidfile: ${String(e)}\n`);
      });
    }

    // Detach the child from the parent's reference count. Without
    // this, the parent's event loop would stay alive waiting on the
    // child even though we never read its (closed) stdio.
    proc.unref();

    // Track spawn-time errors before the socket appears. Capture the
    // first error so we can re-throw it AS the cause instead of letting
    // it dead-end at stderr while waitForSocket times out 10s later
    // with a misleading "Timeout waiting for engine UDS at ..." message.
    // Spawn ENOENT (missing binary), EACCES (not executable), etc. now
    // surface their actual cause to the caller.
    let spawnErr: Error | undefined;
    proc.once('error', (err: Error) => {
      spawnErr = err;
      process.stderr.write(`[opensquid] engine spawn error: ${err.message}\n`);
    });

    try {
      await waitForSocket(sockPath, SOCKET_WAIT_TIMEOUT_MS);
    } catch (waitErr) {
      // Prefer the spawn error if one fired — it's the real cause.
      // The waitForSocket timeout is the symptom, not the diagnosis.
      if (spawnErr) {
        throw new Error(`engine spawn failed before socket appeared: ${spawnErr.message}`, {
          cause: spawnErr,
        });
      }
      throw waitErr;
    }
    const sock = await tryConnect(sockPath);
    return { socket: sock, spawnedByUs: true };
  } finally {
    await release().catch((e: unknown) => {
      // Lock release failure is informational — proper-lockfile's
      // stale-window will let subsequent acquires recover.
      process.stderr.write(
        `[opensquid] warning: failed to release engine spawn lock: ${String(e)}\n`,
      );
    });
  }
}

// ---- Internals -----------------------------------------------------

/**
 * Attempt a UDS connect, resolving with the socket on success and
 * rejecting with the connect-time error on failure. The `error`
 * listener doubles as the rejection path — ECONNREFUSED, ENOENT,
 * etc. all surface here. Caller decides whether to retry / unlink.
 */
function tryConnect(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = connect(path);
    // Cleanup helper — single source of truth for listener removal
    // so success + failure paths don't leak.
    const cleanup = (): void => {
      sock.off('connect', onConnect);
      sock.off('error', onError);
    };
    const onConnect = (): void => {
      cleanup();
      resolve(sock);
    };
    const onError = (err: Error): void => {
      cleanup();
      // Make sure the failed socket doesn't linger in a half-open
      // state on the event loop.
      sock.destroy();
      reject(err);
    };
    sock.once('connect', onConnect);
    sock.once('error', onError);
  });
}

/**
 * Poll for socket existence with a deadline. The engine binds the
 * UDS BEFORE entering its accept loop, so file existence is a sound
 * readiness signal — `connect()` may still race for a tick or two
 * but `tryConnect` handles that.
 */
async function waitForSocket(path: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(path)) return;
    await new Promise<void>((r) => setTimeout(r, SOCKET_WAIT_POLL_INTERVAL_MS));
  }
  throw new Error(
    `Timeout (${String(timeoutMs)}ms) waiting for engine UDS at ${path}. ` +
      `Likely causes: engine binary failed to start (try OPENSQUID_ENGINE_BIN=<path> ` +
      `loop-engine serve --socket ${path} manually to see stderr), or HNSW ` +
      `rehydrate is unusually slow on this machine.`,
  );
}

/**
 * Ensure `~/.opensquid/` exists so the lock + pidfile + socket
 * paths under it are writable. `mkdir -p` semantics — no error if
 * the dir already exists.
 */
async function ensureOpensquidHome(): Promise<void> {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(opensquidHome(), { recursive: true });
}

/**
 * Create the lock file if it doesn't already exist.
 * `proper-lockfile.lock()` rejects with ENOENT if the target is
 * absent; this is the standard touch-then-lock idiom (matches
 * `src/functions/state.ts`).
 */
async function touchFile(path: string): Promise<void> {
  const fh = await open(path, 'a');
  await fh.close();
}
