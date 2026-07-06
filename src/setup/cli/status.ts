/**
 * `opensquid status` (T-v2-audit F5) — the operator-facing v2 discipline inspector. Prints, for a session, the
 * active task, each active v2 pack's FSM state, every gate's pass/fail (with its predicate), and the stage
 * reports emitted — so the discipline can be VERIFIED without watching the terminal or grepping ~/.opensquid.
 *
 * Session resolution: `--session <id>` if given, else the most-recently-modified session under
 * `$OPENSQUID_HOME/sessions` (the live one in normal use). `--json` emits the raw DisciplineStatus.
 */
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { Command } from 'commander';

import { disciplineStatus, formatDisciplineStatus } from '../../runtime/loop/discipline_status.js';
import { markAccepted } from '../../runtime/loop/acceptance.js';
import { recordNeedsRedesign } from '../../runtime/loop/verification.js';
import { OPENSQUID_HOME } from '../../runtime/paths.js';

/** Most-recently-modified session id under $OPENSQUID_HOME/sessions, or null when there are none. */
export async function latestSessionId(home: string = OPENSQUID_HOME()): Promise<string | null> {
  const dir = join(home, 'sessions');
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  let best: { id: string; mtime: number } | null = null;
  for (const id of entries) {
    try {
      const m = (await stat(join(dir, id))).mtimeMs;
      if (best === null || m > best.mtime) best = { id, mtime: m };
    } catch {
      // skip unreadable entries
    }
  }
  return best?.id ?? null;
}

export function registerStatusCli(program: Command): Command {
  // `opensquid accept <taskId>` — the DEPLOY human-accept touchpoint (T2.8). Marks the durable acceptance item
  // accepted so `deploy.accepted` holds and the `accept` decision can reach `done` (instead of looping to PLAN).
  program
    .command('accept <taskId>')
    .description('Accept a task waiting at the DEPLOY gate (the human-accept touchpoint, T2.8)')
    .option('--session <id>', 'session id (default: the most recent session)')
    .action(async (taskId: string, opts: { session?: string }) => {
      const sessionId = opts.session ?? (await latestSessionId());
      if (sessionId === undefined || sessionId === null) {
        process.stdout.write('🦑 no opensquid sessions found.\n');
        return;
      }
      await markAccepted(sessionId, taskId, new Date().toISOString());
      process.stdout.write(`🦑 accepted ${taskId} — the DEPLOY gate can now reach done.\n`);
    });

  // `opensquid redesign <taskId>` (T-deploy-commit-gate scope-2, §5.1) — the DEPLOY-local fix loop's ESCAPE
  // HATCH. By default a red suite is fixed IN DEPLOY (deploy_fix); this flags the active task so the `verify`
  // decision routes red → AUTHOR instead — for a failure that genuinely needs re-authoring (a design-level fix),
  // NOT a mechanical lint/type/test fix. The flag clears automatically on a clean verify. Use sparingly.
  program
    .command('redesign <taskId>')
    .description(
      'Escalate a DEPLOY bug to AUTHOR — the fix needs design rework, not an in-place fix (scope-2)',
    )
    .option('--session <id>', 'session id (default: the most recent session)')
    .option('--clear', 'clear the flag instead of setting it (route back to DEPLOY-local fixing)')
    .action(async (taskId: string, opts: { session?: string; clear?: boolean }) => {
      const sessionId = opts.session ?? (await latestSessionId());
      if (sessionId === undefined || sessionId === null) {
        process.stdout.write('🦑 no opensquid sessions found.\n');
        return;
      }
      const needed = opts.clear !== true;
      await recordNeedsRedesign(sessionId, taskId, needed);
      process.stdout.write(
        needed
          ? `🦑 ${taskId} flagged for redesign — the DEPLOY verify decision now routes to AUTHOR.\n`
          : `🦑 ${taskId} redesign flag cleared — DEPLOY red is fixed in place again.\n`,
      );
    });

  return program
    .command('status')
    .description('Inspect the live v2 discipline: active task, FSM state, gate pass/fail, reports')
    .option('--session <id>', 'session id to inspect (default: the most recent session)')
    .option('--json', 'emit the raw status as JSON')
    .action(async (opts: { session?: string; json?: boolean }) => {
      const sessionId = opts.session ?? (await latestSessionId());
      if (sessionId === undefined || sessionId === null) {
        process.stdout.write('🦑 no opensquid sessions found.\n');
        return;
      }
      const status = await disciplineStatus(sessionId);
      if (opts.json === true) {
        process.stdout.write(JSON.stringify(status, null, 2) + '\n');
        return;
      }
      process.stdout.write(formatDisciplineStatus(status) + '\n');
    });
}
