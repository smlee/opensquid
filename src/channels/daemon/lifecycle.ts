/**
 * chat-transport daemon lifecycle — start / stop / status (CAT.1b).
 *
 * Ported from `src.legacy/chat/daemon/lifecycle.ts` onto the new-tree path
 * helpers (`chatDaemonPidPath` / `chatDaemonLogPath`). Single-instance per
 * machine, keyed on the pidfile under `OPENSQUID_HOME()`.
 *
 *   - `startDaemon` spawns a DETACHED child that re-invokes this binary with
 *     the `chat-daemon-worker` argv token; the child's `runDaemonWorker()`
 *     (worker.ts) writes its own pidfile on boot. Idempotent: a start against
 *     a live daemon returns `{ already_running: true }` without a second spawn.
 *   - `stopDaemon` sends SIGTERM, waits for the grace window, then SIGKILL.
 *     Idempotent.
 *   - `status` is read-only (pidfile + `kill -0` liveness).
 *
 * NOTE — CLI/autospawn wiring is CAT.1d, NOT this task. The `chat-daemon-worker`
 * argv dispatch that actually calls `runDaemonWorker()` is added to the binary
 * entrypoint there; `startDaemon`'s `entrypoint`/`workerArg` options exist so
 * CAT.1d (and tests) can point the spawn wherever they need without editing
 * this module.
 *
 * Imports from: node:child_process, node:fs, node:os, node:path,
 *   ../../runtime/paths.
 * Imported by: CAT.1d CLI + tests.
 */

import { spawn } from 'node:child_process';
import { existsSync, openSync, closeSync, promises as fs } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, resolve } from 'node:path';

import { chatDaemonLogPath, chatDaemonPidPath, OPENSQUID_HOME } from '../../runtime/paths.js';

export type DaemonStatus =
  | { running: true; pid: number; uptime_ms: number | null }
  | { running: false; stale_pid?: number };

/** `kill -0 <pid>` liveness — ESRCH (dead) → false, EPERM (foreign live) → true. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Read the pidfile and report whether the recorded process is alive. A pidfile
 * pointing at a dead pid reports `{ running: false, stale_pid }` — read-only,
 * the caller decides whether to clean it up.
 */
export async function status(): Promise<DaemonStatus> {
  const pidFile = chatDaemonPidPath();
  if (!existsSync(pidFile)) return { running: false };
  let raw: string;
  try {
    raw = await fs.readFile(pidFile, 'utf8');
  } catch {
    return { running: false };
  }
  const pid = parseInt(raw.trim(), 10);
  if (!Number.isFinite(pid) || pid <= 0) return { running: false };
  if (!isProcessAlive(pid)) return { running: false, stale_pid: pid };
  let uptime_ms: number | null = null;
  try {
    const st = await fs.stat(pidFile);
    uptime_ms = Date.now() - st.mtimeMs;
  } catch {
    /* keep null */
  }
  return { running: true, pid, uptime_ms };
}

export interface StartDaemonOptions {
  /** Node binary to spawn. Defaults to `process.execPath`. */
  nodeBin?: string;
  /** Script to re-invoke. Defaults to `process.argv[1]` (the running binary). */
  entrypoint?: string;
  /** argv token the entrypoint dispatches to `runDaemonWorker()`. CAT.1d wires
   *  the dispatch; defaults to `chat-daemon-worker`. */
  workerArg?: string;
}

/**
 * Start the daemon by spawning a detached child running
 * `<nodeBin> <entrypoint> <workerArg>`. Returns once the child has either
 * written its pidfile (success) or the wait timed out (throws). Idempotent.
 */
export async function startDaemon(
  options: StartDaemonOptions = {},
): Promise<{ already_running: boolean; pid: number }> {
  const cur = await status();
  if (cur.running) return { already_running: true, pid: cur.pid };

  const pidFile = chatDaemonPidPath();
  const logFile = chatDaemonLogPath();
  if (cur.stale_pid !== undefined) {
    await fs.unlink(pidFile).catch(() => {
      /* race-tolerant */
    });
  }

  await fs.mkdir(dirname(logFile), { recursive: true });
  // Header line (atomic O_APPEND on POSIX).
  const headerFd = await fs.open(logFile, 'a');
  try {
    await headerFd.write(
      `\n=== chat-daemon start @ ${new Date().toISOString()} ===\n` +
        `host=${hostname()} node=${process.version} platform=${process.platform}\n`,
    );
  } finally {
    await headerFd.close();
  }

  // Raw FD for the child's stdio (spawn wants FDs, not FileHandles).
  const childLogFd = openSync(logFile, 'a');
  const nodeBin = options.nodeBin ?? process.execPath;
  const entrypoint = options.entrypoint ?? resolve(process.argv[1] ?? 'dist/index.js');
  const workerArg = options.workerArg ?? 'chat-daemon-worker';

  const childEnv: NodeJS.ProcessEnv = { ...process.env, OPENSQUID_CHAT_DAEMON: '1' };
  // OPENSQUID_HOME is honored by the child via runtime/paths; thread the
  // resolved value through so a parent that set it (tests) stays consistent.
  childEnv.OPENSQUID_HOME = OPENSQUID_HOME();

  const child = spawn(nodeBin, [entrypoint, workerArg], {
    detached: true,
    stdio: ['ignore', childLogFd, childLogFd],
    env: childEnv,
  });
  child.unref();
  closeSync(childLogFd);

  if (child.pid === undefined) {
    throw new Error('chat-daemon: spawn returned no pid');
  }

  // The worker writes its OWN pidfile on boot; wait for it to appear. Generous
  // timeout — a cold `node` start with grammy in the import graph can exceed
  // 3s on first invocation.
  const workerPid = await waitForPidfile(pidFile, 8000);
  return { already_running: false, pid: workerPid };
}

/**
 * Stop a running daemon: SIGTERM, wait for the grace window, SIGKILL fallback.
 * Idempotent — a stop against a not-running daemon returns `{ stopped: false }`.
 */
export async function stopDaemon(
  options: { graceMs?: number } = {},
): Promise<{ stopped: boolean; pid?: number }> {
  const cur = await status();
  if (!cur.running) {
    if (cur.stale_pid !== undefined) {
      await fs.unlink(chatDaemonPidPath()).catch(() => {
        /* race-tolerant */
      });
    }
    return { stopped: false };
  }
  const grace = options.graceMs ?? 3000;
  try {
    process.kill(cur.pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
  const deadline = Date.now() + grace;
  while (Date.now() < deadline) {
    if (!isProcessAlive(cur.pid)) break;
    await sleep(100);
  }
  if (isProcessAlive(cur.pid)) {
    try {
      process.kill(cur.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  await fs.unlink(chatDaemonPidPath()).catch(() => {
    /* race-tolerant */
  });
  return { stopped: true, pid: cur.pid };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForPidfile(pidFile: string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = await fs.readFile(pidFile, 'utf8');
      const pid = parseInt(raw.trim(), 10);
      if (Number.isFinite(pid) && pid > 0 && isProcessAlive(pid)) return pid;
    } catch {
      /* not yet written */
    }
    await sleep(50);
  }
  throw new Error(`chat-daemon: worker did not write pidfile within ${timeoutMs}ms`);
}
