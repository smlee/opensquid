/**
 * Chat-daemon CLI dispatch (v0.7.1 Phase A).
 *
 * Two entry shapes:
 *   `opensquid chat-daemon {start|stop|status}` — user-facing
 *   `opensquid chat-daemon-worker`              — internal, never type
 *
 * `start` spawns the worker as a detached child and exits. The worker
 * subcommand IS the long-running daemon — never invoke it manually
 * unless you want to inspect logs in the foreground.
 */

import { runDaemonWorker } from "./worker.js";
import { startDaemon, status, stopDaemon } from "./lifecycle.js";

export async function runChatDaemonCli(subcommand: string, argv: string[]): Promise<number> {
  switch (subcommand) {
    case "start": {
      const res = await startDaemon();
      if (res.already_running) {
        process.stdout.write(`[chat-daemon] already running (pid ${res.pid})\n`);
      } else {
        process.stdout.write(`[chat-daemon] started (pid ${res.pid})\n`);
      }
      return 0;
    }
    case "stop": {
      const res = await stopDaemon();
      if (res.stopped) {
        process.stdout.write(`[chat-daemon] stopped (pid ${res.pid})\n`);
      } else {
        process.stdout.write(`[chat-daemon] not running\n`);
      }
      return 0;
    }
    case "status": {
      const s = await status();
      if (s.running) {
        const upMin = s.uptime_ms !== null ? (s.uptime_ms / 60000).toFixed(1) : "?";
        process.stdout.write(`[chat-daemon] running (pid ${s.pid}, up ${upMin}m)\n`);
        return 0;
      }
      if (s.stale_pid !== undefined) {
        process.stdout.write(
          `[chat-daemon] not running (stale pidfile points at ${s.stale_pid})\n`,
        );
        return 1;
      }
      process.stdout.write(`[chat-daemon] not running\n`);
      return 1;
    }
    case "restart": {
      const wasRunning = await status();
      if (wasRunning.running) await stopDaemon();
      const res = await startDaemon();
      process.stdout.write(`[chat-daemon] restarted (pid ${res.pid})\n`);
      return 0;
    }
    default:
      process.stderr.write(
        `[chat-daemon] usage: opensquid chat-daemon {start|stop|status|restart}\n` +
          `  argv received: ${JSON.stringify([subcommand, ...argv])}\n`,
      );
      return 1;
  }
}

/**
 * Internal worker entrypoint — not for direct user invocation.
 * Called by the detached child spawned by lifecycle.startDaemon().
 */
export async function runChatDaemonWorker(): Promise<never> {
  return runDaemonWorker();
}
