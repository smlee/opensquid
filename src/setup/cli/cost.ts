/**
 * `opensquid cost` CLI verb group (CLI.8) — thin commander wiring.
 *
 * Three verbs, all backed by `CostRoutingLog` + `readSubscriptionPools`:
 *
 *   (default)     — pool-usage summary aggregated from `cost_routing_log`.
 *                   Empty log → placeholder.
 *   routing       — last N decisions newest-first (default 20).
 *   subscriptions — list configured pools from `~/.opensquid/config.yaml`.
 *
 * The router doesn't persist by default — `cost_router.ts` exposes an
 * `audit:` sink the daemon wires to `CostRoutingLog.append`. Pure handlers
 * (table renders, log reads, pools loader) live in `./cost_state.ts`;
 * this file owns commander wiring + libsql client lifecycle.
 *
 * Imports from: commander, @libsql/client, ./audit_state.js, ./cost_state.js.
 * Imported by: src/cli.ts, src/setup/cli/cost.test.ts.
 */

import { createClient } from '@libsql/client';

import { applyConcurrencyPragmas } from '../../storage/sqlite_concurrency.js';

import { defaultAuditDbPath } from './audit_state.js';
import {
  CostRoutingLog,
  defaultConfigPath,
  readSubscriptionPools,
  renderRouting,
  renderSubscriptions,
  renderSummary,
} from './cost_state.js';

import type { Client } from '@libsql/client';
import type { Command } from 'commander';

export interface CostCliDeps {
  openClient?: (dbPath: string) => Client;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  now?: () => number;
}

interface ResolvedDeps {
  open: (dbPath: string) => Client;
  out: (s: string) => void;
  err: (s: string) => void;
  now: () => number;
}

function defaultOpen(dbPath: string): Client {
  const url = dbPath.startsWith('file:') || dbPath === ':memory:' ? dbPath : `file:${dbPath}`;
  const client = createClient({ url });
  void applyConcurrencyPragmas(client); // WAL + busy_timeout posture (fire-and-forget; helper never throws)
  return client;
}

function buildDeps(deps: CostCliDeps): ResolvedDeps {
  return {
    open: deps.openClient ?? defaultOpen,
    out: deps.stdout ?? ((s) => process.stdout.write(s)),
    err: deps.stderr ?? ((s) => process.stderr.write(s)),
    now: deps.now ?? ((): number => Date.now()),
  };
}

async function actSummary(deps: ResolvedDeps, opts: { db: string }): Promise<void> {
  const client = deps.open(opts.db);
  try {
    const log = new CostRoutingLog(client);
    const rows = await log.summary();
    if (rows.length === 0) {
      deps.out('(no cost routing decisions yet)\n');
      return;
    }
    deps.out(renderSummary(rows) + '\n');
  } finally {
    client.close();
  }
}

async function actRouting(deps: ResolvedDeps, opts: { db: string; limit: string }): Promise<void> {
  const limit = Number.parseInt(opts.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) {
    deps.err(`opensquid cost routing: --limit "${opts.limit}" must be a positive integer\n`);
    process.exitCode = 1;
    return;
  }
  const client = deps.open(opts.db);
  try {
    const log = new CostRoutingLog(client);
    const rows = await log.recent(limit);
    if (rows.length === 0) {
      deps.out('(no cost routing decisions yet)\n');
      return;
    }
    deps.out(renderRouting(rows) + '\n');
  } finally {
    client.close();
  }
}

async function actSubscriptions(deps: ResolvedDeps, opts: { config: string }): Promise<void> {
  const pools = await readSubscriptionPools(opts.config);
  const total =
    (pools.cheap?.length ?? 0) + (pools.balanced?.length ?? 0) + (pools.premium?.length ?? 0);
  if (total === 0) {
    deps.out('(no subscription pools configured)\n');
    deps.err(
      `hint: declare \`subscription_pools:\` in ${opts.config} — see docs/opensquid-real-design.md\n`,
    );
    return;
  }
  deps.out(renderSubscriptions(pools) + '\n');
}

/** Register `opensquid cost` on the parent program. */
export function registerCost(parent: Command, deps: CostCliDeps = {}): Command {
  const r = buildDeps(deps);
  const c = parent.command('cost').description('Cross-subscription cost routing');
  const db = defaultAuditDbPath();
  const cfg = defaultConfigPath();

  c.option('--db <path>', 'Path to the libsql DB', db).action(async (opts: { db: string }) =>
    actSummary(r, opts),
  );

  c.command('routing')
    .description('Recent cost-tier routing decisions (default: last 20)')
    .option('--db <path>', 'Path to the libsql DB', db)
    .option('--limit <n>', 'cap result count', '20')
    .action((opts: { db: string; limit: string }) => actRouting(r, opts));

  c.command('subscriptions')
    .description('List configured subscription pools (from ~/.opensquid/config.yaml)')
    .option('--config <path>', 'Path to the config YAML', cfg)
    .action((opts: { config: string }) => actSubscriptions(r, opts));

  return c;
}
