/**
 * CLI.2 — `opensquid schedule list|next|history|add|remove|pause|resume|run`.
 *
 * Thin commander wiring. Verb bodies live in `./schedule_actions.ts`;
 * persistence + status + next-fire helpers in `./schedule_state.ts`; table
 * rendering in `./schedule_render.ts`. This file ONLY routes commander
 * options/args into the action functions and resolves default paths from
 * `OPENSQUID_HOME()`.
 *
 * Verb semantics (locked):
 *
 *   list      — pack-declared + user-added merged; `--status` filters per
 *               SCHED.4 wedge-gate sentinel.
 *   next      — minute-by-minute walk over each schedule's cron; daemon-free.
 *   history   — JSONL outcomes from SCHED.4 per-session + force-fire log.
 *   add       — `--cron <expr>` bypasses NL→cron (no LLM call). Otherwise
 *               routes through `nlToCron` (SCHED.3 `fast_classifier`).
 *   remove    — confirms unless `--yes`; user-added only.
 *   pause/    — user-added only (pack-declared: use `triggers disable|
 *     resume    enable`).
 *   run       — force-fire once; appends `cli.run` history entry; dispatches
 *               if a daemon is wired.
 *
 * Imports from: commander, ./schedule_actions, ./schedule_state,
 *   ./triggers_state.
 * Imported by: src/cli.ts.
 */

import {
  actAdd,
  actHistory,
  actList,
  actNext,
  actPauseResume,
  actRemove,
  actRun,
  type ActionDeps,
  type AddOpts,
  type ScheduleDispatch,
} from './schedule_actions.js';
import {
  defaultHistoryPath,
  defaultPausedPath,
  defaultSessionsDir,
  defaultUserSchedulesPath,
} from './schedule_state.js';
import { defaultPacksDir } from './triggers_state.js';

import type { Command } from 'commander';

export type { ScheduleDispatch } from './schedule_actions.js';
export { renderListTable, renderNextTable } from './schedule_render.js';

export interface ScheduleCliDeps {
  packsDir?: string;
  userSchedulesPath?: string;
  pausedPath?: string;
  historyPath?: string;
  sessionsDir?: string;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  isTty?: () => boolean;
  dispatch?: ScheduleDispatch;
  now?: () => Date;
}

const defaultIsTty = (): boolean => process.stdout.isTTY === true;

function buildDeps(deps: ScheduleCliDeps): ActionDeps {
  const actionDeps: ActionDeps = {
    paths: {
      packsDir: deps.packsDir ?? defaultPacksDir(),
      userSchedulesPath: deps.userSchedulesPath ?? defaultUserSchedulesPath(),
      pausedPath: deps.pausedPath ?? defaultPausedPath(),
      historyPath: deps.historyPath ?? defaultHistoryPath(),
      sessionsDir: deps.sessionsDir ?? defaultSessionsDir(),
    },
    out: deps.stdout ?? ((s) => process.stdout.write(s)),
    err: deps.stderr ?? ((s) => process.stderr.write(s)),
    isTty: deps.isTty ?? defaultIsTty,
    now: deps.now ?? ((): Date => new Date()),
  };
  if (deps.dispatch !== undefined) actionDeps.dispatch = deps.dispatch;
  return actionDeps;
}

export function registerSchedule(parent: Command, deps: ScheduleCliDeps = {}): Command {
  const ad = buildDeps(deps);
  const s = parent.command('schedule').description('Manage scheduled jobs');

  s.command('list')
    .description('List all schedules (pack-declared + user-added)')
    .option('--pack <pack>')
    .option('--status <status>', 'probationary|permanent|retired')
    .action((opts: { pack?: string; status?: string }) => actList(ad, opts));

  s.command('next')
    .description('Upcoming firings (next 10 by default)')
    .option('--limit <n>', '10', '10')
    .action((opts: { limit: string }) => actNext(ad, opts));

  s.command('history')
    .description('Recent fires across all schedules (force-fires + scheduled fires)')
    .option('--limit <n>', '50', '50')
    .option('--id <scheduleId>', 'restrict to one schedule')
    .action((opts: { limit: string; id?: string }) => actHistory(ad, opts));

  s.command('add <description>')
    .description('Add a schedule. <description> is NL or pass --cron for an exact expression.')
    .option('--cron <expr>', 'exact 5-field POSIX cron expression (skips NL→cron translation)')
    .requiredOption('--pack <pack>')
    .requiredOption('--skill <skill>')
    .option('--cost-tier <tier>', 'cheap|balanced|premium')
    .option('--timezone <tz>', 'IANA timezone (defaults to UTC)')
    .action((description: string, opts: AddOpts) => actAdd(ad, description, opts));

  s.command('remove <id>')
    .description('Remove a user-added schedule (confirms unless --yes)')
    .option('--yes', 'skip confirmation', false)
    .action((id: string, opts: { yes: boolean }) => actRemove(ad, id, opts));

  s.command('pause <id>')
    .description('Pause a user-added schedule (pack-declared: use triggers disable)')
    .action((id: string) => actPauseResume(ad, 'pause', id));

  s.command('resume <id>')
    .description('Resume a user-added schedule (pack-declared: use triggers enable)')
    .action((id: string) => actPauseResume(ad, 'resume', id));

  s.command('run <id>')
    .description('Force-fire a schedule once (writes history; dispatches if daemon wired)')
    .option('--yes', 'skip confirmation', false)
    .action((id: string, opts: { yes: boolean }) => actRun(ad, id, opts));

  return s;
}
