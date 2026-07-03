/**
 * CLI.5 — `opensquid audit (list|shell|channels|pending|tail|approve|reject)`.
 *
 * Thin commander wiring. Verb bodies in `./audit_actions.ts`; libsql
 * paths + duration parser in `./audit_state.ts`. This file owns commander
 * option routing + libsql client lifecycle (open → action → close).
 *
 * Verb semantics (locked):
 *   - list      — default; newest N across all categories. Filters:
 *                 --since, --decision, --category, --limit.
 *   - shell     — pending_shell rows (queue history).
 *   - channels  — channel_send rows (deliver-only + outbound multicast).
 *   - pending   — pending_shell + decision=prompted (the approval queue).
 *   - tail      — live polling. `--follow` until SIGINT; otherwise exits
 *                 after first batch. AbortController owns lifecycle.
 *   - approve / reject — atomic prompted → terminal. Exit 1 if already
 *                 resolved (race-safe via single UPDATE).
 */

import { createClient } from '@libsql/client';

import { applyConcurrencyPragmas } from '../../storage/sqlite_concurrency.js';

import { AuditLog } from '../../runtime/audit_log.js';

import {
  actApprove,
  actChannels,
  actList,
  actPending,
  actReject,
  actShell,
  actTail,
  type ActionDeps,
  type CommonFilterOpts,
  type ListOpts,
} from './audit_actions.js';
import { defaultAuditDbPath } from './audit_state.js';

import type { Client } from '@libsql/client';
import type { Command } from 'commander';

export interface AuditCliDeps {
  /** Tests inject in-memory client + force-abort tail deterministically. */
  openClient?: (dbPath: string) => Client;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  now?: () => number;
  abort?: AbortController;
}

function defaultOpen(dbPath: string): Client {
  const url = dbPath.startsWith('file:') || dbPath === ':memory:' ? dbPath : `file:${dbPath}`;
  const client = createClient({ url });
  void applyConcurrencyPragmas(client); // WAL + busy_timeout posture (fire-and-forget; helper never throws)
  return client;
}

interface ResolvedDeps {
  open: (dbPath: string) => Client;
  out: (s: string) => void;
  err: (s: string) => void;
  now: () => number;
  abort?: AbortController;
}

function buildDeps(deps: AuditCliDeps): ResolvedDeps {
  const out: ResolvedDeps = {
    open: deps.openClient ?? defaultOpen,
    out: deps.stdout ?? ((s) => process.stdout.write(s)),
    err: deps.stderr ?? ((s) => process.stderr.write(s)),
    now: deps.now ?? ((): number => Date.now()),
  };
  if (deps.abort !== undefined) out.abort = deps.abort;
  return out;
}

async function withLog(
  resolved: ResolvedDeps,
  dbPath: string,
  body: (deps: ActionDeps) => Promise<void>,
): Promise<void> {
  const client = resolved.open(dbPath);
  try {
    const log = new AuditLog(client);
    const deps: ActionDeps = {
      log,
      out: resolved.out,
      err: resolved.err,
      now: resolved.now,
      ...(resolved.abort !== undefined ? { abort: resolved.abort } : {}),
    };
    await body(deps);
  } finally {
    client.close();
  }
}

const DB_DESC = 'Path to the libsql DB';
const SINCE_DESC = 'e.g. 24h, 7d, 30m, 60s';
const CAT_LIST = 'capability_gate|webhook|schedule|resume|channel_send|pending_shell';
const DEC_LIST = 'allowed|denied|prompted|success|error|approved|rejected';

export function registerAudit(parent: Command, deps: AuditCliDeps = {}): Command {
  const r = buildDeps(deps);
  const a = parent.command('audit').description('Unified audit log');
  const db = defaultAuditDbPath();

  a.command('list', { isDefault: true })
    .description('Recent audit entries (default: 20)')
    .option('--db <path>', DB_DESC, db)
    .option('--since <duration>', SINCE_DESC)
    .option('--decision <kind>', DEC_LIST)
    .option('--category <kind>', CAT_LIST)
    .option('--limit <n>', 'cap result count (default 20)')
    .action(async (opts: ListOpts & { db: string }) => {
      await withLog(r, opts.db, (d) => actList(d, opts));
    });

  a.command('shell')
    .description('Pending-shell queue history (pending_shell category)')
    .option('--db <path>', DB_DESC, db)
    .option('--since <duration>', SINCE_DESC)
    .option('--decision <kind>', 'prompted|approved|rejected|denied')
    .option('--limit <n>', 'cap result count (default 20)')
    .action(async (opts: CommonFilterOpts & { db: string }) => {
      await withLog(r, opts.db, (d) => actShell(d, opts));
    });

  a.command('channels')
    .description('Channel send audit (channel_send category)')
    .option('--db <path>', DB_DESC, db)
    .option('--since <duration>', SINCE_DESC)
    .option('--decision <kind>', 'success|error|denied')
    .option('--limit <n>', 'cap result count (default 20)')
    .action(async (opts: CommonFilterOpts & { db: string }) => {
      await withLog(r, opts.db, (d) => actChannels(d, opts));
    });

  a.command('pending')
    .description('Pending shell_exec approvals (pending_shell + decision=prompted)')
    .option('--db <path>', DB_DESC, db)
    .option('--since <duration>', SINCE_DESC)
    .option('--limit <n>', 'cap result count (default 50)')
    .action(async (opts: CommonFilterOpts & { db: string }) => {
      await withLog(r, opts.db, (d) => actPending(d, opts));
    });

  a.command('tail')
    .description('Stream new audit entries as they land')
    .option('--db <path>', DB_DESC, db)
    .option('-f, --follow', 'Keep tailing until SIGINT', false)
    .option('--interval <ms>', 'Polling interval (default 1000ms, floor 100ms)', '1000')
    .option('--category <kind>', CAT_LIST)
    .action(async (opts: { db: string; follow: boolean; interval: string; category?: string }) => {
      const controller = r.abort ?? new AbortController();
      const onSigint = (): void => {
        controller.abort();
      };
      process.on('SIGINT', onSigint);
      try {
        await withLog(r, opts.db, (d) =>
          actTail(d, {
            follow: opts.follow,
            interval: opts.interval,
            ...(opts.category !== undefined ? { category: opts.category } : {}),
            signal: controller.signal,
          }),
        );
      } finally {
        process.off('SIGINT', onSigint);
        if (r.abort === undefined) controller.abort();
      }
    });

  a.command('approve <pendingId>')
    .description('Approve a queued shell_exec (atomic prompted → approved)')
    .option('--db <path>', DB_DESC, db)
    .action(async (pendingId: string, opts: { db: string }) => {
      await withLog(r, opts.db, (d) => actApprove(d, pendingId));
    });

  a.command('reject <pendingId>')
    .description('Reject a queued shell_exec (atomic prompted → rejected)')
    .option('--db <path>', DB_DESC, db)
    .action(async (pendingId: string, opts: { db: string }) => {
      await withLog(r, opts.db, (d) => actReject(d, pendingId));
    });

  return a;
}
