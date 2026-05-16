/**
 * Chat-daemon lifecycle — start / stop / status (v0.7.1 Phase A).
 *
 * The daemon owns the single long-poll connection per chat platform so
 * multiple Claude Code projects sharing the same machine can run their
 * own opensquid MCP servers without colliding on the bot token (Telegram
 * returns 409 Conflict when two consumers long-poll the same token —
 * the v0.7 cause of "last-connected wins" behavior).
 *
 * Lifecycle is single-instance per machine: PID file at
 * ~/.opensquid/chat-daemon.pid, log at ~/.opensquid/chat-daemon.log.
 * A `start` call against a running daemon is a no-op (idempotent);
 * `stop` is also idempotent. `status` is read-only.
 *
 * Outbound RPC (Unix socket) lands in Phase B; routing config + inbox
 * write-out in Phase C; auto-spawn from MCP server in Phase D.
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { resolveDataRoot } from "../../codex/store.js";

export interface DaemonPaths {
  pidFile: string;
  logFile: string;
  sockFile: string;
}

export function daemonPaths(dataRoot?: string): DaemonPaths {
  const root = resolveDataRoot(dataRoot);
  return {
    pidFile: path.join(root, "chat-daemon.pid"),
    logFile: path.join(root, "chat-daemon.log"),
    sockFile: path.join(root, "chat-daemon.sock"),
  };
}

export type DaemonStatus =
  | { running: true; pid: number; uptime_ms: number | null }
  | { running: false; stale_pid?: number };

/**
 * Read the pidfile and check whether the recorded process is alive.
 * A pidfile that points at a dead pid is treated as not-running (the
 * caller should clean it up if they want; status itself is read-only).
 */
export async function status(dataRoot?: string): Promise<DaemonStatus> {
  const paths = daemonPaths(dataRoot);
  if (!existsSync(paths.pidFile)) return { running: false };
  let raw: string;
  try {
    raw = await fs.readFile(paths.pidFile, "utf8");
  } catch {
    return { running: false };
  }
  const pid = parseInt(raw.trim(), 10);
  if (!Number.isFinite(pid) || pid <= 0) return { running: false };
  if (!isProcessAlive(pid)) return { running: false, stale_pid: pid };
  let uptime_ms: number | null = null;
  try {
    const stat = await fs.stat(paths.pidFile);
    uptime_ms = Date.now() - stat.mtimeMs;
  } catch {
    /* keep null */
  }
  return { running: true, pid, uptime_ms };
}

/** `kill -0 <pid>` portable check — throws ESRCH if dead, EPERM if alive-but-foreign. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM"; // alive but owned by another user (still counts)
  }
}

/**
 * Start the daemon by spawning a detached child that runs
 * `node dist/index.js chat-daemon-worker` (the actual long-poll loop
 * lives in worker.ts). Returns immediately once the child has either
 * forked successfully or failed.
 *
 * Idempotent: a start against an already-running daemon returns
 * `{ already_running: true, pid }` without launching a second process.
 *
 * Stale pidfile handling: if the pidfile points at a dead pid, it's
 * silently removed so this call can succeed.
 */
export async function startDaemon(
  options: { dataRoot?: string; nodeBin?: string; entrypoint?: string } = {},
): Promise<{ already_running: boolean; pid: number }> {
  const cur = await status(options.dataRoot);
  if (cur.running) return { already_running: true, pid: cur.pid };

  const paths = daemonPaths(options.dataRoot);
  if (cur.stale_pid !== undefined) {
    await fs.unlink(paths.pidFile).catch(() => {
      /* race-tolerant */
    });
  }

  // The log file is opened append-mode by both the parent (header
  // line) and the child (stdout/stderr). fs.open with 'a' is atomic
  // append on POSIX, which is what we want here — no race between
  // start runs.
  await fs.mkdir(path.dirname(paths.logFile), { recursive: true });
  const logFd = await fs.open(paths.logFile, "a");
  try {
    await logFd.write(
      `\n=== chat-daemon start @ ${new Date().toISOString()} ===\n` +
        `host=${os.hostname()} node=${process.version} platform=${process.platform}\n`,
    );
  } finally {
    await logFd.close();
  }

  // Reopen the log file for the child's stdio. spawn() wants raw FDs,
  // not FileHandles, so we open via the sync API.
  const fsSync = await import("node:fs");
  const childLogFd = fsSync.openSync(paths.logFile, "a");

  const nodeBin = options.nodeBin ?? process.execPath;
  const entrypoint = options.entrypoint ?? defaultEntrypoint();
  // Pass dataRoot through to the worker via OPENSQUID_HOME so the
  // worker's resolveDataRoot() lands in the same tree the parent
  // selected. Tests pass a tmpdir here; production uses the default
  // ~/.opensquid resolution.
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    OPENSQUID_CHAT_DAEMON: "1",
  };
  if (options.dataRoot) childEnv.OPENSQUID_HOME = options.dataRoot;
  const child = spawn(nodeBin, [entrypoint, "chat-daemon-worker"], {
    detached: true,
    stdio: ["ignore", childLogFd, childLogFd],
    env: childEnv,
  });

  // unref so the parent (this process) can exit without waiting for the
  // child. The child is now an independent process group leader because
  // of detached:true.
  child.unref();
  fsSync.closeSync(childLogFd);

  if (!child.pid) {
    throw new Error("chat-daemon: spawn returned no pid");
  }

  // The worker writes its OWN pidfile on startup (so the recorded pid
  // is the worker's, not a stale spawn-only value). Wait briefly for
  // the pidfile to appear; if it doesn't, the worker died on startup.
  // The timeout is generous (8s) because a cold-start of `node
  // dist/index.js chat-daemon-worker` with the optional grammy /
  // discord.js / @slack/* SDKs in the import graph can exceed 3s on
  // first invocation. Subsequent starts hit OS file cache and complete
  // in <500ms.
  const workerPid = await waitForPidfile(paths.pidFile, 8000);
  return { already_running: false, pid: workerPid };
}

/**
 * Stop a running daemon by sending SIGTERM, then waiting briefly for
 * the process to exit and the pidfile to disappear. Falls back to
 * SIGKILL after the grace period. Idempotent — a stop against a
 * not-running daemon returns `{ stopped: false }` without error.
 */
export async function stopDaemon(
  options: { dataRoot?: string; graceMs?: number } = {},
): Promise<{ stopped: boolean; pid?: number }> {
  const cur = await status(options.dataRoot);
  if (!cur.running) {
    // Clean up stale pidfile if present.
    if (cur.stale_pid !== undefined) {
      await fs.unlink(daemonPaths(options.dataRoot).pidFile).catch(() => {
        /* race-tolerant */
      });
    }
    return { stopped: false };
  }
  const grace = options.graceMs ?? 3000;
  try {
    process.kill(cur.pid, "SIGTERM");
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
      process.kill(cur.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  // Pidfile cleanup is the worker's job on graceful shutdown — but
  // best-effort here for the SIGKILL path.
  await fs.unlink(daemonPaths(options.dataRoot).pidFile).catch(() => {
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
      const raw = await fs.readFile(pidFile, "utf8");
      const pid = parseInt(raw.trim(), 10);
      if (Number.isFinite(pid) && pid > 0 && isProcessAlive(pid)) return pid;
    } catch {
      /* not yet written */
    }
    await sleep(50);
  }
  throw new Error(`chat-daemon: worker did not write pidfile within ${timeoutMs}ms`);
}

/**
 * Find the on-disk path of the running opensquid binary so the child
 * can re-invoke the same module. Defaults to argv[1] (the script Node
 * was invoked with) which is `dist/index.js` for normal usage.
 */
function defaultEntrypoint(): string {
  // process.argv[1] may be a relative path when launched via npx; resolve.
  return path.resolve(process.argv[1] ?? "dist/index.js");
}
