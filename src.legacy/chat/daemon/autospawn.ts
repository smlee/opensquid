/**
 * Daemon auto-spawn from MCP server (v0.7.1 Phase D).
 *
 * On MCP server boot, we want to opportunistically ensure the chat-
 * daemon is running so chat_send routes through the daemon (Phase B)
 * and inbound messages land in per-project inboxes (Phase C). Without
 * auto-spawn the user has to remember `opensquid chat-daemon start`
 * once per machine after every reboot, which defeats the
 * "unconscious tool" goal.
 *
 * Behavior:
 *   - No-op if no chat_connections configured (no point in a daemon
 *     with zero adapters).
 *   - No-op if daemon already running.
 *   - Otherwise try to acquire an atomic spawn lock (fs.open(lock,
 *     'wx') — EEXIST = another MCP server is spawning). If acquired,
 *     spawn and release. If not, wait briefly for the other process's
 *     pidfile to appear.
 *   - Always async fire-and-forget — never blocks MCP server boot.
 *
 * Stale lock handling: a lockfile older than ~15s is assumed stale
 * (longer than the plausible spawn time) and is unlinked before
 * retry. Prevents permanent jam if a previous spawner crashed.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { resolveDataRoot } from "../../codex/store.js";
import { loadChatConfig } from "../config.js";
import { startDaemon, status } from "./lifecycle.js";

const STALE_LOCK_AGE_MS = 15_000;
const PIDFILE_WAIT_MS = 8_000;
const PIDFILE_POLL_INTERVAL_MS = 100;

export interface AutoSpawnResult {
  status: "spawned" | "already_running" | "waited_for_peer" | "no_config" | "skipped" | "error";
  pid?: number;
  error?: string;
}

/**
 * Best-effort: ensure a chat-daemon is running. Returns immediately
 * on the no-op paths (no config, already running, peer-spawning).
 * Never throws — callers can fire-and-forget without try/catch.
 */
export async function ensureDaemonRunning(
  opts: {
    dataRoot?: string;
    /** For tests: override the entrypoint passed to startDaemon. */
    entrypoint?: string;
  } = {},
): Promise<AutoSpawnResult> {
  try {
    const config = await loadChatConfig(opts.dataRoot);
    if (!config.telegram && !config.discord && !config.slack) {
      return { status: "no_config" };
    }
    const s = await status(opts.dataRoot);
    if (s.running) return { status: "already_running", pid: s.pid };

    const lockPath = spawnLockPath(opts.dataRoot);
    const acquired = await tryAcquireLock(lockPath);
    if (acquired) {
      try {
        // Re-check after acquiring the lock; a peer might have
        // finished spawning between our first status() and lock
        // acquisition.
        const s2 = await status(opts.dataRoot);
        if (s2.running) return { status: "already_running", pid: s2.pid };
        const res = await startDaemon({
          dataRoot: opts.dataRoot,
          entrypoint: opts.entrypoint,
        });
        return res.already_running
          ? { status: "already_running", pid: res.pid }
          : { status: "spawned", pid: res.pid };
      } finally {
        await releaseLock(lockPath);
      }
    }

    // Another MCP server has the lock — wait for the pidfile to
    // appear, then trust that daemon.
    const pid = await waitForPeerSpawn(opts.dataRoot);
    if (pid !== null) return { status: "waited_for_peer", pid };
    return { status: "error", error: "peer spawn timed out" };
  } catch (err) {
    return {
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function spawnLockPath(dataRoot?: string): string {
  return path.join(resolveDataRoot(dataRoot), "chat-daemon.spawn.lock");
}

async function tryAcquireLock(lockPath: string): Promise<boolean> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  try {
    const fd = await fs.open(lockPath, "wx");
    await fd.write(`${process.pid}\n`);
    await fd.close();
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    // Lock exists. Check age — if stale, unlink and retry once.
    try {
      const stat = await fs.stat(lockPath);
      if (Date.now() - stat.mtimeMs > STALE_LOCK_AGE_MS) {
        await fs.unlink(lockPath).catch(() => {
          /* race */
        });
        return tryAcquireLock(lockPath);
      }
    } catch {
      /* lock vanished between EEXIST and stat — retry */
      return tryAcquireLock(lockPath);
    }
    return false;
  }
}

async function releaseLock(lockPath: string): Promise<void> {
  await fs.unlink(lockPath).catch(() => {
    /* race-tolerant */
  });
}

async function waitForPeerSpawn(dataRoot?: string): Promise<number | null> {
  const deadline = Date.now() + PIDFILE_WAIT_MS;
  while (Date.now() < deadline) {
    const s = await status(dataRoot);
    if (s.running) return s.pid;
    await new Promise((r) => setTimeout(r, PIDFILE_POLL_INTERVAL_MS));
  }
  return null;
}
