/**
 * `opensquid cache` CLI verb group (CLI.7).
 *
 * Two verbs, backed by the DURABLE.3 `MemoCache`:
 *
 *   stats  — per-primitive hit / size table. Reads `MemoCache.stats()`,
 *            which queries the libsql tier (the authoritative cross-
 *            restart record). The in-memory LRU tier deliberately does
 *            NOT contribute — a restart would otherwise reset reported
 *            hits to zero and trip the "is this thing working" check
 *            (see memo_cache.ts MemoStats comment).
 *   clear  — selective invalidation. `--primitive <name>` purges one
 *            primitive's rows; `--older-than <duration>` purges rows
 *            older than the window; both flags combine via AND. A
 *            zero-filter (full) clear requires `--yes` or interactive
 *            y/N confirmation; non-TTY without `--yes` exits 1.
 *
 * Confirmation policy (locked):
 *   - At least one filter → no confirmation. Output reports row count
 *     removed; the user already declared the scope.
 *   - No filter (full wipe) → `--yes` or TTY confirmation required.
 *     Mirrors the `checkpoints clean` non-TTY refusal pattern.
 *
 * File-size budget: this file ≤ 200 LOC including both verbs (CLI.7
 * deliverable). Pure runtime logic (`MemoCache.stats` / `.clear`)
 * already lives in `runtime/durable/memo_cache.ts`; we just wire
 * commander + format output.
 *
 * Imports from: commander, @libsql/client, ../../runtime/durable/index.js,
 *   ./audit_state.js (parseDurationToMs + defaultAuditDbPath).
 * Imported by: src/cli.ts, src/setup/cli/cache.test.ts.
 */

import { createClient } from '@libsql/client';

import { MemoCache, type MemoStats } from '../../runtime/durable/index.js';

import { defaultAuditDbPath, parseDurationToMs } from './audit_state.js';

import type { Client } from '@libsql/client';
import type { Command } from 'commander';

export interface CacheCliDeps {
  openClient?: (dbPath: string) => Client;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  isTty?: () => boolean;
  now?: () => number;
}

interface ResolvedDeps {
  open: (dbPath: string) => Client;
  out: (s: string) => void;
  err: (s: string) => void;
  isTty: () => boolean;
  now: () => number;
}

function defaultOpen(dbPath: string): Client {
  const url = dbPath.startsWith('file:') || dbPath === ':memory:' ? dbPath : `file:${dbPath}`;
  return createClient({ url });
}

function buildDeps(deps: CacheCliDeps): ResolvedDeps {
  return {
    open: deps.openClient ?? defaultOpen,
    out: deps.stdout ?? ((s: string): void => void process.stdout.write(s)),
    err: deps.stderr ?? ((s: string): void => void process.stderr.write(s)),
    isTty: deps.isTty ?? ((): boolean => process.stdout.isTTY === true),
    now: deps.now ?? ((): number => Date.now()),
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

// Fixed-column table render. Same posture as checkpoints_render.ts —
// human-eyeballed columns, jq-piped consumers should query libsql directly.
function renderStatsTable(rows: readonly MemoStats[]): string {
  const lines: string[] = [];
  lines.push(pad('PRIMITIVE', 24) + pad('HITS', 10) + pad('SIZE', 10));
  for (const r of rows) {
    lines.push(pad(r.fn, 24) + pad(String(r.hits), 10) + pad(String(r.size), 10));
  }
  return lines.join('\n');
}

function pad(s: string, w: number): string {
  if (s.length >= w) return s.slice(0, w - 1) + ' ';
  return s + ' '.repeat(w - s.length);
}

interface StatsOpts {
  db: string;
}

async function actStats(deps: ResolvedDeps, opts: StatsOpts): Promise<void> {
  const client = deps.open(opts.db);
  try {
    const cache = new MemoCache(client, { nowMs: deps.now });
    await cache.init();
    const rows = await cache.stats();
    if (rows.length === 0) {
      deps.out('(no cached primitives)\n');
      return;
    }
    deps.out(renderStatsTable(rows) + '\n');
  } finally {
    client.close();
  }
}

interface ClearOpts {
  db: string;
  primitive?: string;
  olderThan?: string;
  yes: boolean;
}

async function actClear(deps: ResolvedDeps, opts: ClearOpts): Promise<void> {
  // Parse --older-than first so a bad duration aborts before opening the DB.
  let olderThanMs: number | undefined;
  if (opts.olderThan !== undefined) {
    const parsed = parseDurationToMs(opts.olderThan);
    if (parsed === null) {
      deps.err(
        `opensquid cache clear: --older-than "${opts.olderThan}" must be like 30s|10m|2h|7d\n`,
      );
      process.exitCode = 1;
      return;
    }
    olderThanMs = parsed;
  }

  const hasFilter = opts.primitive !== undefined || olderThanMs !== undefined;

  // Full clear (no filter) — require --yes or TTY confirmation.
  if (!hasFilter) {
    if (!opts.yes && !deps.isTty()) {
      deps.err(
        'opensquid cache clear: refusing full clear without --yes in non-interactive context\n',
      );
      process.exitCode = 1;
      return;
    }
    if (!opts.yes && !(await confirmTty('Clear ALL cached primitives? [y/N] ', deps.isTty))) {
      deps.out('aborted\n');
      return;
    }
  }

  const client = deps.open(opts.db);
  try {
    const cache = new MemoCache(client, { nowMs: deps.now });
    await cache.init();
    const clearOpts: { fn?: string; olderThanMs?: number } = {};
    if (opts.primitive !== undefined) clearOpts.fn = opts.primitive;
    if (olderThanMs !== undefined) clearOpts.olderThanMs = olderThanMs;
    const removed = await cache.clear(clearOpts);
    deps.out(`removed ${String(removed)} cache row${removed === 1 ? '' : 's'}\n`);
  } finally {
    client.close();
  }
}

/** Register `opensquid cache` on the parent program. */
export function registerCache(parent: Command, deps: CacheCliDeps = {}): Command {
  const r = buildDeps(deps);
  const c = parent.command('cache').description('Memoization cache (DURABLE.3)');
  const db = defaultAuditDbPath();

  c.command('stats')
    .description('Per-primitive hit / size table from the persistent cache tier')
    .option('--db <path>', 'Path to the libsql DB', db)
    .action((opts: StatsOpts) => actStats(r, opts));

  c.command('clear')
    .description('Invalidate cache entries (selective by --primitive / --older-than, or full)')
    .option('--db <path>', 'Path to the libsql DB', db)
    .option('--primitive <name>', 'restrict to one primitive (e.g. llm_classify)')
    .option('--older-than <duration>', 'remove rows cached more than this ago (e.g. 7d)')
    .option('--yes', 'skip confirmation for full clear', false)
    .action((opts: ClearOpts) => actClear(r, opts));

  return c;
}
