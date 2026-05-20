#!/usr/bin/env node
/**
 * `opensquid` CLI entry. SCHED.1 adds the `daemon` verb tree:
 *
 *   opensquid daemon status     — read pid file, report running PID + uptime
 *
 * `start` / `stop` / `restart` are stubbed (deferred to the UI track) — but
 * `status` lands here because the acceptance criteria for SCHED.1 require
 * the verb to return cleanly with exit 0 when no daemon is running, so the
 * caller in tests + downstream UI work has a stable boundary.
 *
 * `start` / `stop` are deliberately NOT implemented as one-liners here
 * because spawning the daemon as a real long-lived process requires the
 * launchd / systemd integration (UI track) — running it inline would block
 * the CLI invocation forever, which is a foot-gun for first-time users.
 */

import { Command } from 'commander';

import { OpenSquidDaemon } from './runtime/daemon.js';
import { daemonPidPath } from './runtime/paths.js';

const program = new Command()
  .name('opensquid')
  .description('Tracks for your AI agent — destination-first.')
  .version('0.5.65');

const daemon = program.command('daemon').description('Background daemon lifecycle');

daemon
  .command('status')
  .description('Report daemon status (running PID + uptime, or "not running").')
  .action(async () => {
    // Use a transient daemon instance solely for its `status()` reader —
    // the constructor allocates no resources until `start()` runs.
    const instance = new OpenSquidDaemon({
      packs: [],
      subscriptions: [],
      dispatch: async () => {
        /* status check never dispatches */
      },
    });
    const status = await instance.status();
    if (status.running) {
      process.stdout.write(
        `daemon: running (pid ${String(status.pid ?? '?')}, schedules ${String(
          status.scheduleCount ?? '?',
        )}, webhook port ${String(status.webhookPort ?? '?')})\n`,
      );
    } else {
      process.stdout.write(`daemon: not running (no pid file at ${daemonPidPath()})\n`);
    }
  });

daemon
  .command('start')
  .description('Start the background daemon (deferred to UI track — see daemon status).')
  .action(() => {
    process.stderr.write(
      'opensquid daemon start: not yet wired — launchd/systemd integration ships in the UI track\n',
    );
    process.exitCode = 1;
  });

daemon
  .command('stop')
  .description('Stop the background daemon (deferred to UI track).')
  .action(() => {
    process.stderr.write(
      'opensquid daemon stop: not yet wired — launchd/systemd integration ships in the UI track\n',
    );
    process.exitCode = 1;
  });

daemon
  .command('restart')
  .description('Restart the background daemon (deferred to UI track).')
  .action(() => {
    process.stderr.write(
      'opensquid daemon restart: not yet wired — launchd/systemd integration ships in the UI track\n',
    );
    process.exitCode = 1;
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`opensquid: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
