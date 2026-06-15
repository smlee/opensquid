/**
 * Limits-CLI persistence helpers (CLI.8) — split out of limits.ts for the
 * file-size budget.
 *
 * Two concerns:
 *
 *   1. `enumeratePackRateLimits` — walk a packs directory (default
 *      `~/.opensquid/packs/`), load each pack's `manifest.yaml` via the
 *      Manifest schema, and surface the `rate_limits:` block per pack.
 *      Unconfigured packs (no `rate_limits:`) contribute zero rows — the
 *      limits CLI surface mirrors the runtime: only declared (pack,
 *      trigger) pairs have caps, everything else is unlimited.
 *
 *   2. `readBuckets` / `resetPackBuckets` — direct libsql access to the
 *      AUTO.2 `rate_limit_buckets` table (the runtime state owned by
 *      `RateLimiter`). The CLI deliberately reads rows directly rather
 *      than instantiating a `RateLimiter` because the limiter API exposes
 *      `check` / `release` (single-key mutations) — not enumerate. Reset
 *      uses a single `DELETE FROM ... WHERE pack_id = ?` so post-reset
 *      `check()` on any (trigger, key) pair starts from a fresh bucket
 *      (no row → defaults to `max` tokens per the limiter's read path).
 *
 * Pack-side data: only the schema-validated `rate_limits` block; the
 * runtime Pack type strips it (see `src/runtime/types.ts`), so we re-parse
 * manifest.yaml here rather than hooking the loader. Same precedent as
 * `triggers_state.enumeratePacks` re-loading via `loadPack`.
 *
 * Imports from: node:fs/promises, node:path, @libsql/client,
 *   ../../packs/schemas/manifest, ../../packs/yaml, ../../runtime/paths.
 * Imported by: src/setup/cli/limits.ts + src/setup/cli/limits.test.ts.
 */

import { join } from 'node:path';

import { Manifest } from '../../packs/schemas/manifest.js';
import { parseYamlFile } from '../../packs/yaml.js';
import { OPENSQUID_HOME } from '../../runtime/paths.js';

import { walkPacksDir } from './pack_walk.js';

import type { Client } from '@libsql/client';
import type { RateLimits as RateLimitsType } from '../../packs/schemas/manifest.js';
import type { TriggerKind } from '../../packs/schemas/skill.js';

export const defaultPacksDir = (): string => join(OPENSQUID_HOME(), 'packs');

/** One pack's declared rate-limit block. `rateLimits` is the
 *  manifest-parsed map (trigger kind → config); empty when the pack
 *  omits the block (i.e. unlimited across triggers). */
export interface PackRateLimitDecl {
  packId: string;
  rateLimits: RateLimitsType;
}

/** Walk packs/ and pull each pack's `rate_limits:` block. Packs without
 *  a manifest.yaml are skipped (matches `triggers_state` posture). */
export function enumeratePackRateLimits(packsDir: string): Promise<PackRateLimitDecl[]> {
  return walkPacksDir(packsDir, async (dir) => {
    const { data } = await parseYamlFile(join(dir, 'manifest.yaml'), Manifest);
    return { packId: data.name, rateLimits: data.rate_limits ?? {} };
  });
}

/** One row from `rate_limit_buckets`. `tokens` is the current refilled
 *  count; `lastRefillMs` is the last-touch timestamp used for continuous
 *  refill math. */
export interface BucketRow {
  packId: string;
  triggerKind: TriggerKind;
  key: string;
  tokens: number;
  lastRefillMs: number;
  concurrentCount: number;
}

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS rate_limit_buckets (
    pack_id TEXT NOT NULL,
    trigger_kind TEXT NOT NULL,
    key TEXT NOT NULL,
    tokens REAL NOT NULL,
    last_refill_ms INTEGER NOT NULL,
    concurrent_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (pack_id, trigger_kind, key)
  );
`;

/** Read ALL buckets across packs. Used by the default `limits` verb to
 *  enumerate runtime state when joined against pack-declared caps. */
export async function readAllBuckets(db: Client): Promise<BucketRow[]> {
  await db.execute(CREATE_TABLE_SQL);
  const rs = await db.execute(
    `SELECT pack_id, trigger_kind, key, tokens, last_refill_ms, concurrent_count
     FROM rate_limit_buckets
     ORDER BY pack_id ASC, trigger_kind ASC, key ASC`,
  );
  return rs.rows.map((r) => {
    const row = r as Record<string, unknown>;
    return {
      packId: String(row.pack_id),
      triggerKind: String(row.trigger_kind) as TriggerKind,
      key: String(row.key),
      tokens: Number(row.tokens),
      lastRefillMs: Number(row.last_refill_ms),
      concurrentCount: Number(row.concurrent_count),
    };
  });
}

/** Atomic delete of all buckets for one pack. Returns the deleted row
 *  count so the CLI can confirm action. */
export async function resetPackBuckets(db: Client, packId: string): Promise<number> {
  await db.execute(CREATE_TABLE_SQL);
  const rs = await db.execute({
    sql: `DELETE FROM rate_limit_buckets WHERE pack_id = ?`,
    args: [packId],
  });
  return Number(rs.rowsAffected);
}

// ---------------------------------------------------------------------------
// Render helpers — split out of limits.ts for the 150-LOC file-size budget.
// Same posture as checkpoints_render.ts (CLI.6).
// ---------------------------------------------------------------------------

/** Joined per-pack per-trigger row surfaced by the default `limits` verb. */
export interface LimitRow {
  pack: string;
  trigger: TriggerKind;
  max: number;
  used: number;
  remaining: number;
}

/** Aggregate buckets by (pack, trigger) — worst-case (lowest tokens) wins
 *  so the CLI surfaces "what's about to throttle". Trigger-keys other
 *  than the default `<pack>::<trigger>` (per-skill, per-event) collapse
 *  into one row per (pack, trigger). */
export function buildLimitRows(
  decls: readonly PackRateLimitDecl[],
  buckets: readonly BucketRow[],
): LimitRow[] {
  const bucketByKey = new Map<string, BucketRow>();
  for (const b of buckets) {
    const k = `${b.packId}::${b.triggerKind}`;
    const existing = bucketByKey.get(k);
    if (existing === undefined || b.tokens < existing.tokens) bucketByKey.set(k, b);
  }
  const rows: LimitRow[] = [];
  for (const decl of decls) {
    for (const [trigger, cfg] of Object.entries(decl.rateLimits)) {
      if (cfg === undefined) continue;
      const bucket = bucketByKey.get(`${decl.packId}::${trigger}`);
      const tokens = bucket?.tokens ?? cfg.max;
      const remaining = Math.max(0, Math.floor(tokens));
      const used = Math.max(0, cfg.max - remaining);
      rows.push({
        pack: decl.packId,
        trigger: trigger as TriggerKind,
        max: cfg.max,
        used,
        remaining,
      });
    }
  }
  return rows;
}

function pad(s: string, w: number): string {
  if (s.length >= w) return s.slice(0, w - 1) + ' ';
  return s + ' '.repeat(w - s.length);
}

export function renderLimitsTable(rows: readonly LimitRow[]): string {
  const lines: string[] = [
    pad('PACK', 24) + pad('TRIGGER', 18) + pad('MAX', 8) + pad('USED', 8) + pad('REMAINING', 10),
  ];
  for (const r of rows) {
    lines.push(
      pad(r.pack, 24) +
        pad(r.trigger, 18) +
        pad(String(r.max), 8) +
        pad(String(r.used), 8) +
        pad(String(r.remaining), 10),
    );
  }
  return lines.join('\n');
}
