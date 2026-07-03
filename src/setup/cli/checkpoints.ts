/**
 * `opensquid checkpoints` CLI verb group (CLI.6).
 *
 * Four verbs, all backed by `CheckpointStore` (DURABLE.1) + optional
 * `Resumer` (DURABLE.4):
 *
 *   list    — print interrupted-run summaries. `--limit <n>` caps
 *             (default 20). `--interrupted` is a no-op alias —
 *             `scanInterrupted` already excludes terminated runs.
 *   show    — RAW JSONL dump of one run: manifest line + one line per
 *             checkpoint row (sorted by `stepIdx`) + terminal-marker
 *             line when present. Distinct from `opensquid trace`
 *             (OBSERVE.2), which renders a styled timeline.
 *   resume  — explicit resume that BYPASSES DURABLE.4's 60s window
 *             (`Resumer.resume` is window-free; only `scanInterrupted`
 *             / `resumeOnStartup` consult the window). Confirmation
 *             unless `--yes`. Requires a daemon-wired Resumer.
 *   clean   — prune checkpoints older than a duration (default 30d).
 *             Confirmation unless `--yes`.
 *
 * This file owns commander wiring + dep-building only. Pure handlers
 * live in `./checkpoints_core.ts` (re-exported here so direct-import
 * callers from the DURABLE.4 scaffold keep working). Action bodies +
 * libsql client lifecycle live in `./checkpoints_actions.ts`. Table
 * rendering lives in `./checkpoints_render.ts`.
 *
 * Imports from: commander, @libsql/client, ../../runtime/durable/index.js,
 *   ../../runtime/paths.js, ./checkpoints_actions.js, ./checkpoints_core.js.
 * Imported by: src/setup/cli/checkpoints.test.ts, src/cli.ts.
 */

import { createClient } from '@libsql/client';

import { OPENSQUID_HOME } from '../../runtime/paths.js';
import { applyConcurrencyPragmas } from '../../storage/sqlite_concurrency.js';

import { actClean, actList, actResume, actShow, type ActionDeps } from './checkpoints_actions.js';

import type { Client } from '@libsql/client';
import type { Command } from 'commander';
import type { CheckpointStore, Resumer, RuleResolver } from '../../runtime/durable/index.js';

// Re-export the pure handlers + shapes from the DURABLE.4 scaffold so that
// existing direct-import callers (`import * as cli from './checkpoints.js'`)
// continue to find `cli.list` / `cli.show` / `cli.resume` / `cli.clean`.
export {
  clean,
  list,
  resume,
  show,
  type CleanOpts,
  type ListEntry,
  type ListOpts,
  type ResumeCliResult,
  type ShowResult,
} from './checkpoints_core.js';

export interface CheckpointsCliDeps {
  openClient?: (dbPath: string) => Client;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  isTty?: () => boolean;
  now?: () => number;
  /** Production wires a Resumer with packs loaded; tests inject a stub. */
  resumerFor?: (store: CheckpointStore) => Resumer | null;
}

function defaultDbPath(): string {
  return `file:${OPENSQUID_HOME()}/opensquid.db`;
}

function defaultOpen(dbPath: string): Client {
  const url = dbPath.startsWith('file:') || dbPath === ':memory:' ? dbPath : `file:${dbPath}`;
  const client = createClient({ url });
  void applyConcurrencyPragmas(client); // WAL + busy_timeout posture (fire-and-forget; helper never throws)
  return client;
}

function buildDeps(deps: CheckpointsCliDeps): ActionDeps {
  const out: ActionDeps = {
    open: deps.openClient ?? defaultOpen,
    out: deps.stdout ?? ((s: string): void => void process.stdout.write(s)),
    err: deps.stderr ?? ((s: string): void => void process.stderr.write(s)),
    isTty: deps.isTty ?? ((): boolean => process.stdout.isTTY === true),
    now: deps.now ?? ((): number => Date.now()),
  };
  if (deps.resumerFor !== undefined) out.resumerFor = deps.resumerFor;
  return out;
}

/** Register `opensquid checkpoints` on the parent program. */
export function registerCheckpoints(parent: Command, deps: CheckpointsCliDeps = {}): Command {
  const ad = buildDeps(deps);
  const c = parent.command('checkpoints').description('Durable-execution checkpoint store');
  const db = defaultDbPath();

  c.command('list')
    .description('List interrupted runs (durable-execution checkpoint store)')
    .option('--db <path>', 'Path to the libsql DB', db)
    .option('--interrupted', 'only show interrupted runs (default: true)')
    .option('--limit <n>', 'cap result count (default 20)')
    .action((opts: { db: string; interrupted?: boolean; limit?: string }) => actList(ad, opts));

  c.command('show <runId>')
    .description('Raw JSONL dump of one run (manifest + checkpoints + terminal)')
    .option('--db <path>', 'Path to the libsql DB', db)
    .action((runId: string, opts: { db: string }) => actShow(ad, runId, opts));

  c.command('resume <runId>')
    .description('Manually resume an interrupted run (overrides DURABLE.4 resume window)')
    .option('--db <path>', 'Path to the libsql DB', db)
    .option('--yes', 'skip confirmation', false)
    .action((runId: string, opts: { db: string; yes: boolean }) => actResume(ad, runId, opts));

  c.command('clean')
    .description('Prune old checkpoint rows (confirms unless --yes)')
    .option('--db <path>', 'Path to the libsql DB', db)
    .option('--older-than <duration>', 'e.g. 7d, 30d', '30d')
    .option('--yes', 'skip confirmation', false)
    .action((opts: { db: string; olderThan: string; yes: boolean }) => actClean(ad, opts));

  return c;
}

// Re-export the RuleResolver type so the CLI binding site can declare a
// matching `resumerFor` factory without importing the durable module a
// second time.
export type { RuleResolver };
