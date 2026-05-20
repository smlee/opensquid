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
import { registerTraceCommand } from './setup/cli/trace.js';
import { registerTriggers } from './setup/cli/triggers.js';
import { InvalidCronError, InvalidScheduleInputError, nlToCron } from './setup/schedule_nl.js';

const program = new Command()
  .name('opensquid')
  .description('Tracks for your AI agent — destination-first.')
  .version('0.5.78');

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

// `schedule` verb tree — SCHED.3 lands `schedule add <NL>` which translates a
// natural-language schedule into a 5-field POSIX cron expression via the
// codex-declared `fast_classifier` alias. Persistence + lifecycle (enable /
// disable / list) ship in later SCHED.* tasks; SCHED.3's scope is "NL in,
// cron out" so a pack author can sanity-check the translation before wiring.
const schedule = program.command('schedule').description('Schedule management (NL → cron)');

schedule
  .command('add')
  .description('Translate a natural-language schedule into a 5-field POSIX cron expression.')
  .argument('<nl>', 'Natural-language schedule (e.g. "every Monday at 9am")')
  .option(
    '--alias <alias>',
    'Model alias to dispatch through (default: fast_classifier)',
    'fast_classifier',
  )
  .option('--skill <skill>', 'Skill to attach the schedule to (recorded only — not persisted yet)')
  .option('--pack <pack>', 'Pack to attach the schedule to (recorded only — not persisted yet)')
  .action(async (nl: string, opts: { alias: string; skill?: string; pack?: string }) => {
    try {
      const result = await nlToCron(nl, { alias: opts.alias });
      const payload: Record<string, string> = {
        cron: result.cron,
        nl_input: result.nl_input,
        confidence: result.confidence,
      };
      if (result.timezone !== undefined) payload.timezone = result.timezone;
      if (opts.skill !== undefined) payload.skill = opts.skill;
      if (opts.pack !== undefined) payload.pack = opts.pack;
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } catch (e: unknown) {
      if (e instanceof InvalidScheduleInputError || e instanceof InvalidCronError) {
        process.stderr.write(`opensquid schedule add: ${e.message}\n`);
        process.exitCode = 1;
        return;
      }
      process.stderr.write(
        `opensquid schedule add: ${e instanceof Error ? e.message : String(e)}\n`,
      );
      process.exitCode = 1;
    }
  });

// OBSERVE.2 — `opensquid trace <runId> | tail | export <runId>`.
// Registered via a sibling module to keep the verb tree's commander wiring
// + libsql client lifecycle ownership out of `cli.ts`.
registerTraceCommand(program);

// CLI.1 — `opensquid triggers list|show|fire|enable|disable`. Unified view
// of skill `triggers:` blocks across all installed packs + user-side
// enable/disable persistence (`~/.opensquid/trigger_state.yaml`). No
// dispatcher wired here yet — `fire` errors cleanly until the daemon
// surfaces an injectable dispatch handle (deferred to a later CLI task).
registerTriggers(program);

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`opensquid: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
