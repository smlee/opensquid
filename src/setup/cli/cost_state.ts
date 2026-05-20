/**
 * Cost-CLI persistence helpers (CLI.8) — split out of cost.ts for the
 * file-size budget.
 *
 * Three concerns:
 *
 *   1. `defaultConfigPath` / `readSubscriptionPools` — load configured
 *      subscription pools from `~/.opensquid/config.yaml` (`subscription_pools:`
 *      block keyed by tier). Empty file / missing block → empty record (the
 *      CLI surfaces this as "no pools configured" rather than crashing —
 *      `cost subscriptions` should still print a clean message before any
 *      pools have been declared). Malformed YAML throws (no silent fail-open).
 *
 *   2. `CostRoutingLog` — libsql-backed audit table for AUTO.7 `CostRouter`
 *      routing decisions. The router itself takes a caller-wired
 *      `audit: (entry) => void` sink (see `src/models/cost_router.ts`); the
 *      daemon wires that sink to `CostRoutingLog.append`. The CLI's
 *      `cost routing` / `cost` (default summary) read from this table.
 *
 *      Schema mirrors the `CostRoutingAuditEntry` shape: (tier, alias,
 *      success, reason, timestamp). Idempotent `CREATE TABLE IF NOT EXISTS`
 *      on first init — matches the AUTO.2 `rate_limit_buckets` + CLI.5
 *      `audit_log` posture (no versioned migration framework in opensquid
 *      yet).
 *
 *   3. `formatTimestamp` — re-exports `audit_state.ts`'s ISO formatter to
 *      keep cost-side imports inside one helper file. Same precedent as
 *      `cache.ts` importing `parseDurationToMs` from `audit_state.ts`.
 *
 * Imports from: node:fs/promises, yaml, @libsql/client,
 *   ../../models/cost_router, ../../runtime/paths.
 * Imported by: src/setup/cli/cost.ts + src/setup/cli/cost.test.ts.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parse as parseYaml } from 'yaml';

import { OPENSQUID_HOME } from '../../runtime/paths.js';

import { formatTimestamp } from './audit_state.js';

import type { Client } from '@libsql/client';
import type { CostTier, SubscriptionPool } from '../../models/cost_router.js';

export { formatTimestamp };

/** Per-tier subscription pools as declared in `~/.opensquid/config.yaml`. */
export type SubscriptionPoolsByTier = Partial<Record<CostTier, SubscriptionPool[]>>;

export const defaultConfigPath = (): string => join(OPENSQUID_HOME(), 'config.yaml');

/** Read configured pools. Missing file / missing block → empty record. */
export async function readSubscriptionPools(path: string): Promise<SubscriptionPoolsByTier> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    throw new Error(
      `config.yaml is malformed (${path}): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`config.yaml must be a mapping (${path})`);
  }
  const pools = (parsed as { subscription_pools?: unknown }).subscription_pools;
  if (pools === undefined || pools === null) return {};
  if (typeof pools !== 'object' || Array.isArray(pools)) {
    throw new Error(`config.yaml: \`subscription_pools\` must be a mapping (${path})`);
  }
  const result: SubscriptionPoolsByTier = {};
  for (const tier of ['cheap', 'balanced', 'premium'] as const) {
    const list = (pools as Record<string, unknown>)[tier];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      throw new Error(`config.yaml: \`subscription_pools.${tier}\` must be a list (${path})`);
    }
    result[tier] = list
      .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null)
      .map((p) => normalizePool(p));
  }
  return result;
}

function normalizePool(p: Record<string, unknown>): SubscriptionPool {
  const base: SubscriptionPool = {
    alias: typeof p.alias === 'string' ? p.alias : '',
    provider: typeof p.provider === 'string' ? p.provider : '',
    model: typeof p.model === 'string' ? p.model : '',
  };
  if (typeof p.rateLimit === 'object' && p.rateLimit !== null) {
    const rl = p.rateLimit as { rpm?: unknown; tpm?: unknown };
    const rpm = Number(rl.rpm);
    if (Number.isFinite(rpm)) {
      base.rateLimit = typeof rl.tpm === 'number' ? { rpm, tpm: rl.tpm } : { rpm };
    }
  }
  return base;
}

/**
 * libsql-backed log of `CostRouter.pick()` decisions. The daemon wires
 * `CostRouter`'s `audit:` sink to `append`; the CLI reads via `recent`.
 *
 * `success` stored as 0/1 (SQLite has no boolean). `reason` is the
 * machine-readable cause when `success=false` (`empty_tier` |
 * `all_rate_limited`).
 */
export interface CostRoutingRow {
  id: number;
  occurredAtMs: number;
  tier: CostTier;
  alias: string | null;
  success: boolean;
  reason: string | null;
}

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS cost_routing_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    occurred_at_ms INTEGER NOT NULL,
    tier TEXT NOT NULL,
    alias TEXT,
    success INTEGER NOT NULL,
    reason TEXT
  );
`;

const CREATE_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_cost_routing_occurred
    ON cost_routing_log(occurred_at_ms);
`;

export class CostRoutingLog {
  private initialized = false;
  constructor(private readonly db: Client) {}

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.db.execute(CREATE_TABLE_SQL);
    await this.db.execute(CREATE_INDEX_SQL);
    this.initialized = true;
  }

  /** Append one decision. `occurredAtMs` from caller-supplied clock. */
  async append(entry: {
    occurredAtMs: number;
    tier: CostTier;
    alias: string | null;
    success: boolean;
    reason?: string | null;
  }): Promise<void> {
    await this.init();
    await this.db.execute({
      sql: `INSERT INTO cost_routing_log (occurred_at_ms, tier, alias, success, reason)
            VALUES (?, ?, ?, ?, ?)`,
      args: [
        entry.occurredAtMs,
        entry.tier,
        entry.alias,
        entry.success ? 1 : 0,
        entry.reason ?? null,
      ],
    });
  }

  /** Most-recent N decisions, newest-first. */
  async recent(limit: number): Promise<CostRoutingRow[]> {
    await this.init();
    const rs = await this.db.execute({
      sql: `SELECT id, occurred_at_ms, tier, alias, success, reason
            FROM cost_routing_log
            ORDER BY occurred_at_ms DESC, id DESC
            LIMIT ?`,
      args: [Math.max(1, Math.floor(limit))],
    });
    return rs.rows.map((r) => ({
      id: Number((r as Record<string, unknown>).id),
      occurredAtMs: Number((r as Record<string, unknown>).occurred_at_ms),
      tier: String((r as Record<string, unknown>).tier) as CostTier,
      alias:
        (r as Record<string, unknown>).alias === null ||
        (r as Record<string, unknown>).alias === undefined
          ? null
          : String((r as Record<string, unknown>).alias),
      success: Number((r as Record<string, unknown>).success) === 1,
      reason:
        (r as Record<string, unknown>).reason === null ||
        (r as Record<string, unknown>).reason === undefined
          ? null
          : String((r as Record<string, unknown>).reason),
    }));
  }

  /** Aggregate row counts per (tier, alias). Used by the default `cost`
   *  summary verb to render pool usage across tiers. */
  async summary(): Promise<SummaryRow[]> {
    await this.init();
    const rs = await this.db.execute(
      `SELECT tier, alias, COUNT(*) AS picks
       FROM cost_routing_log
       WHERE success = 1 AND alias IS NOT NULL
       GROUP BY tier, alias
       ORDER BY tier ASC, picks DESC`,
    );
    return rs.rows.map((r) => ({
      tier: String((r as Record<string, unknown>).tier) as CostTier,
      alias: String((r as Record<string, unknown>).alias),
      picks: Number((r as Record<string, unknown>).picks),
    }));
  }
}

// ---------------------------------------------------------------------------
// Render helpers — split out of cost.ts for the 180-LOC file-size budget.
// ---------------------------------------------------------------------------

export interface SummaryRow {
  tier: CostTier;
  alias: string;
  picks: number;
}

function pad(s: string, w: number): string {
  if (s.length >= w) return s.slice(0, w - 1) + ' ';
  return s + ' '.repeat(w - s.length);
}

export function renderSummary(rows: readonly SummaryRow[]): string {
  const lines: string[] = [pad('TIER', 12) + pad('ALIAS', 24) + pad('PICKS', 10)];
  for (const r of rows) {
    lines.push(pad(r.tier, 12) + pad(r.alias, 24) + pad(String(r.picks), 10));
  }
  return lines.join('\n');
}

export function renderRouting(rows: readonly CostRoutingRow[]): string {
  const lines: string[] = [
    pad('TIMESTAMP', 28) +
      pad('TIER', 10) +
      pad('ALIAS', 20) +
      pad('STATUS', 10) +
      pad('REASON', 22),
  ];
  for (const r of rows) {
    lines.push(
      pad(formatTimestamp(r.occurredAtMs), 28) +
        pad(r.tier, 10) +
        pad(r.alias ?? '-', 20) +
        pad(r.success ? 'picked' : 'failed', 10) +
        pad(r.reason ?? '-', 22),
    );
  }
  return lines.join('\n');
}

export function renderSubscriptions(pools: SubscriptionPoolsByTier): string {
  const lines: string[] = [
    pad('TIER', 12) + pad('ALIAS', 24) + pad('PROVIDER', 14) + pad('MODEL', 28),
  ];
  for (const tier of ['cheap', 'balanced', 'premium'] as const) {
    const list = pools[tier] ?? [];
    for (const p of list) {
      lines.push(pad(tier, 12) + pad(p.alias, 24) + pad(p.provider, 14) + pad(p.model, 28));
    }
  }
  return lines.join('\n');
}
