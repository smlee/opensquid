/**
 * chat-transport daemon CLI (T-CHAT-AS-TERMINAL CAT.1d).
 *
 * Two entry shapes, mirroring the legacy `src.legacy/chat/daemon/cli.ts` so
 * `lifecycle.startDaemon` (which re-invokes `process.argv[1]` with the
 * `chat-daemon-worker` token) keeps working against the NEW binary (`dist/
 * cli.js`):
 *
 *   `opensquid chat-daemon {start|stop|status|restart}` — user-facing, a
 *       commander sub-group registered on the root program.
 *   `opensquid chat-daemon-worker`                       — internal, never
 *       typed by a user. Handled by an EARLY short-circuit in `src/cli.ts`
 *       (before commander parses) because the worker parks the event loop and
 *       never returns. `runChatDaemonWorkerEntry` is that entrypoint.
 *
 * `start` spawns the worker as a detached child and returns once the child has
 * written its pidfile. The wiring is intentionally thin — all the real
 * lifecycle logic lives in `./lifecycle.ts` + `./worker.ts`.
 *
 * Imports from: commander, ./lifecycle, ./worker.
 * Imported by: src/cli.ts.
 */

import type { Command } from 'commander';

import { startDaemon, status, stopDaemon } from './lifecycle.js';
import { runDaemonWorker } from './worker.js';

/**
 * Internal worker entrypoint — invoked by the detached child that
 * `lifecycle.startDaemon` spawns. Never returns (parks the event loop); signal
 * handlers inside `runDaemonWorker` drive shutdown. On an unexpected throw it
 * logs + exits non-zero so the parent's pidfile-wait fails fast.
 */
export async function runChatDaemonWorkerEntry(): Promise<never> {
  try {
    return await runDaemonWorker();
  } catch (err) {
    process.stderr.write(
      `[chat-daemon-worker] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exit(1);
  }
}

/**
 * Register `opensquid chat-daemon {start|stop|status|restart}` on the root
 * program. Each verb wraps the matching `./lifecycle` function. `start` /
 * `restart` spawn the detached worker via `chat-daemon-worker`; `status` is
 * read-only; `stop` is idempotent.
 */
export function registerChatDaemon(program: Command): Command {
  const group = program
    .command('chat-daemon')
    .description('chat-transport daemon lifecycle (start/stop/status/restart).');

  group
    .command('start')
    .description('Spawn the detached chat-transport daemon (idempotent).')
    .action(async () => {
      const res = await startDaemon();
      process.stdout.write(
        res.already_running
          ? `[chat-daemon] already running (pid ${String(res.pid)})\n`
          : `[chat-daemon] started (pid ${String(res.pid)})\n`,
      );
    });

  group
    .command('stop')
    .description('Stop the running chat-transport daemon (idempotent).')
    .action(async () => {
      const res = await stopDaemon();
      process.stdout.write(
        res.stopped
          ? `[chat-daemon] stopped (pid ${String(res.pid)})\n`
          : '[chat-daemon] not running\n',
      );
    });

  group
    .command('status')
    .description('Report chat-transport daemon status (running pid + uptime).')
    .action(async () => {
      const s = await status();
      if (s.running) {
        const upMin = s.uptime_ms !== null ? (s.uptime_ms / 60000).toFixed(1) : '?';
        process.stdout.write(`[chat-daemon] running (pid ${String(s.pid)}, up ${upMin}m)\n`);
        return;
      }
      if (s.stale_pid !== undefined) {
        process.stdout.write(
          `[chat-daemon] not running (stale pidfile points at ${String(s.stale_pid)})\n`,
        );
        process.exitCode = 1;
        return;
      }
      process.stdout.write('[chat-daemon] not running\n');
      process.exitCode = 1;
    });

  group
    .command('restart')
    .description('Stop (if running) then start the chat-transport daemon.')
    .action(async () => {
      const cur = await status();
      if (cur.running) await stopDaemon();
      const res = await startDaemon();
      process.stdout.write(`[chat-daemon] restarted (pid ${String(res.pid)})\n`);
    });

  return group;
}
