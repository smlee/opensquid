/**
 * Chat-daemon worker entrypoint (v0.7.1 Phase A).
 *
 * Spawned as a detached child by `lifecycle.startDaemon()`. Owns the
 * single long-poll connection per chat platform. The MCP server side
 * stays out of the polling business entirely — outbound RPC (Phase B)
 * and inbox tailing (Phase C) replace the in-process gateway.
 *
 * Lifecycle inside the worker:
 *   1. Write our PID to ~/.opensquid/chat-daemon.pid
 *   2. Build the chat gateway from ~/.opensquid/config.json
 *   3. Start every configured adapter (their long-poll loops run as
 *      side effects of start())
 *   4. Install SIGTERM / SIGINT handlers that stop the gateway and
 *      remove the pidfile before exit
 *   5. Park on process.stdin (which is /dev/null in detached mode)
 *      so the event loop stays alive
 *
 * Crash behavior: any unhandled exception from gateway.start() prints
 * to the (parent-redirected) log file and exits non-zero. The pidfile
 * is cleaned up in the SIGTERM handler — if we crash before installing
 * it, the pidfile may linger, and the next `status` call will report
 * `stale_pid` (lifecycle.startDaemon cleans up stale pidfiles before
 * spawning).
 */

import { promises as fs } from "node:fs";

import { buildChatGateway } from "../factory.js";
import type { ChatGateway } from "../gateway.js";
import { daemonPaths } from "./lifecycle.js";

let gateway: ChatGateway | null = null;
let pidFile: string | null = null;
let shuttingDown = false;

export async function runDaemonWorker(dataRoot?: string): Promise<never> {
  const paths = daemonPaths(dataRoot);
  pidFile = paths.pidFile;

  // Write pidfile FIRST so a status check after spawn sees the worker
  // promptly. Truncate-write is the right semantic — any previous
  // pidfile is stale by definition (we already verified no live daemon
  // existed in lifecycle.startDaemon).
  await fs.writeFile(pidFile, `${process.pid}\n`, "utf8");

  log(`[chat-daemon] worker booted pid=${process.pid} cwd=${process.cwd()}`);

  // Build + start the gateway. If config is empty, no adapters
  // activate and the daemon parks idle — useful for testing the
  // lifecycle without configuring a real bot token.
  try {
    const built = await buildChatGateway({ dataRoot });
    gateway = built.gateway;
    log(`[chat-daemon] activating platforms: ${built.activated.join(",") || "(none)"}`);
    if (built.issues.length) {
      for (const i of built.issues) {
        log(`[chat-daemon] config issue ${i.platform}.${i.field}: ${i.problem}`);
      }
    }
    await gateway.start();
    log(`[chat-daemon] gateway start complete; entering park loop`);
  } catch (err) {
    log(`[chat-daemon] FATAL: gateway start failed: ${err instanceof Error ? err.stack : err}`);
    await cleanup();
    process.exit(1);
  }

  // Signal handlers. SIGTERM = graceful, SIGINT = also graceful (for
  // manual `kill` during dev). Each calls cleanup() exactly once.
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // Park forever. process.stdin.resume() does NOT work here because
  // the parent spawned us with `stdio: ['ignore', ...]` — there's no
  // FD 0 to poll. An unresolved Promise alone won't hold the event
  // loop either; Node exits when nothing's scheduled. The reliable
  // pattern is a long-interval no-op timer (~12 days per tick); the
  // tick is a microsecond of CPU and easily survives clock jitter.
  // Signal handlers are independently registered above and still fire.
  setInterval(() => {
    /* keep-alive heartbeat */
  }, 1 << 30);

  // TypeScript demands a return path even though we never reach here.
  return await new Promise<never>(() => {
    /* never resolves; held alive by the heartbeat interval */
  });
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`[chat-daemon] ${signal} received, shutting down...`);
  try {
    if (gateway) await gateway.shutdown();
  } catch (err) {
    log(
      `[chat-daemon] gateway.shutdown error (non-fatal): ${err instanceof Error ? err.message : err}`,
    );
  }
  await cleanup();
  log(`[chat-daemon] clean exit`);
  process.exit(0);
}

async function cleanup(): Promise<void> {
  if (pidFile) {
    try {
      await fs.unlink(pidFile);
    } catch {
      /* race-tolerant */
    }
  }
}

function log(line: string): void {
  // stdio is already redirected to the log file by the parent's spawn
  // options; plain console.log lands in the right place.
  process.stdout.write(`${new Date().toISOString()} ${line}\n`);
}
