/**
 * `opensquid limits` CLI verb group (CLI.8) — thin commander wiring.
 *
 * Two verbs, both backed by `RateLimiter` state (AUTO.2):
 *
 *   (default)     — per-pack per-trigger budget table (max + used + remaining).
 *                   Joins pack-declared `rate_limits:` blocks with live bucket
 *                   rows. Unconfigured triggers contribute no rows (runtime
 *                   treats them as unlimited; CLI mirrors that).
 *   reset <pack>  — atomic `DELETE FROM rate_limit_buckets WHERE pack_id = ?`.
 *                   Confirmation required: `--yes` flag OR interactive y/N.
 *                   Non-TTY without `--yes` refuses with exit 1.
 *
 * Pure handlers live in `./limits_state.ts` (enumerate + read + reset +
 * render); this file owns commander wiring + libsql client lifecycle.
 *
 * Imports from: commander, @libsql/client, ./audit_state.js, ./limits_state.js.
 * Imported by: src/cli.ts, src/setup/cli/limits.test.ts.
 */

import { createClient } from '@libsql/client';

import { applyConcurrencyPragmas } from '../../storage/sqlite_concurrency.js';

import { defaultAuditDbPath } from './audit_state.js';
import {
  buildLimitRows,
  defaultPacksDir,
  enumeratePackRateLimits,
  readAllBuckets,
  renderLimitsTable,
  resetPackBuckets,
} from './limits_state.js';

import type { Client } from '@libsql/client';
import type { Command } from 'commander';

export interface LimitsCliDeps {
  openClient?: (dbPath: string) => Client;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  isTty?: () => boolean;
}

interface ResolvedDeps {
  open: (dbPath: string) => Client;
  out: (s: string) => void;
  err: (s: string) => void;
  isTty: () => boolean;
}

function defaultOpen(dbPath: string): Client {
  const url = dbPath.startsWith('file:') || dbPath === ':memory:' ? dbPath : `file:${dbPath}`;
  const client = createClient({ url });
  void applyConcurrencyPragmas(client); // WAL + busy_timeout posture (fire-and-forget; helper never throws)
  return client;
}

function buildDeps(deps: LimitsCliDeps): ResolvedDeps {
  return {
    open: deps.openClient ?? defaultOpen,
    out: deps.stdout ?? ((s) => process.stdout.write(s)),
    err: deps.stderr ?? ((s) => process.stderr.write(s)),
    isTty: deps.isTty ?? ((): boolean => process.stdout.isTTY === true),
  };
}

async function confirmTty(question: string, isTty: () => boolean): Promise<boolean> {
  if (!isTty()) return false;
  const rl = (await import('node:readline/promises')).createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

async function actDefault(
  deps: ResolvedDeps,
  opts: { db: string; packsDir: string },
): Promise<void> {
  const decls = await enumeratePackRateLimits(opts.packsDir);
  const client = deps.open(opts.db);
  try {
    const buckets = await readAllBuckets(client);
    const rows = buildLimitRows(decls, buckets);
    if (rows.length === 0) {
      deps.out('(no pack-declared rate limits)\n');
      return;
    }
    deps.out(renderLimitsTable(rows) + '\n');
  } finally {
    client.close();
  }
}

async function actReset(
  deps: ResolvedDeps,
  pack: string,
  opts: { db: string; yes: boolean },
): Promise<void> {
  if (!opts.yes && !deps.isTty()) {
    deps.err(
      `opensquid limits reset: refusing to reset "${pack}" without --yes in non-interactive context\n`,
    );
    process.exitCode = 1;
    return;
  }
  if (
    !opts.yes &&
    !(await confirmTty(`Reset rate-limit usage for "${pack}"? [y/N] `, deps.isTty))
  ) {
    deps.out('aborted\n');
    return;
  }
  const client = deps.open(opts.db);
  try {
    const removed = await resetPackBuckets(client, pack);
    deps.out(`reset ${String(removed)} bucket row${removed === 1 ? '' : 's'} for "${pack}"\n`);
  } finally {
    client.close();
  }
}

/** Register `opensquid limits` on the parent program. */
export function registerLimits(parent: Command, deps: LimitsCliDeps = {}): Command {
  const r = buildDeps(deps);
  const l = parent.command('limits').description('Pack rate-limit state');
  const db = defaultAuditDbPath();
  const packsDir = defaultPacksDir();

  l.option('--db <path>', 'Path to the libsql DB', db)
    .option('--packs-dir <path>', 'Path to the packs directory', packsDir)
    .action((opts: { db: string; packsDir: string }) => actDefault(r, opts));

  l.command('reset <pack>')
    .description('Clear usage window for a pack (admin override)')
    .option('--db <path>', 'Path to the libsql DB', db)
    .option('--yes', 'skip confirmation', false)
    .action((pack: string, opts: { db: string; yes: boolean }) => actReset(r, pack, opts));

  return l;
}
