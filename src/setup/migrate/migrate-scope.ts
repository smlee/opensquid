/**
 * Migrate legacy-tagged memory rows to the first-class `tier`/`namespace` columns
 * (T-memory-scope-isolation S4). Pre-scope rows carry the Rust-era tag `scope:!project <name>` or
 * `scope:user`; this maps them to the new columns so EXISTING memories scope correctly (new writes
 * already do). Additive, idempotent, DRY-RUN by default — mutate only with `apply:true`, and on a COPY
 * of `~/.opensquid/rag.sqlite` first. NEVER deletes a row (the never-delete axiom); conserves counts.
 *
 * Mapping (verified against the live store): `scope:!project loop` → namespace `loop`;
 * `scope:!project RaumPilates-FE` → namespace `raumpilates`; everything else (`scope:user`, empty
 * `!project ''`, bare `scope:project`, unknown project names) → `shared` (safe over-share, never a leak).
 *
 * Imports from: @libsql/client, ../../rag/types.js.
 * Imported by: src/cli.ts (the `migrate-scope` command) + the test.
 */
import { createClient } from '@libsql/client';

import type { MemoryTier } from '../../rag/types.js';

/** Old Rust project NAME (from the `scope:!project <name>` tag) → the umbrella namespace id. */
const NAME_TO_NAMESPACE: Record<string, string> = {
  loop: 'loop',
  'RaumPilates-FE': 'raumpilates',
};

export interface ScopeAssignment {
  tier: MemoryTier;
  namespace: string | null;
}

/**
 * PURE: map a row's tags to (tier, namespace). A `scope:!project <name>` whose name is a KNOWN umbrella
 * maps to that namespace; anything else (user/global, empty name, bare `scope:project`, unknown name) →
 * `shared`. Conservative by design: when in doubt, over-share (the never-FORGET axiom) — never isolate
 * a row to a namespace we can't verify.
 */
export function classifyScope(tags: string[]): ScopeAssignment {
  for (const t of tags) {
    const m = /^scope:!project\s+'?([^']*)'?\s*$/.exec(t);
    const name = m?.[1]?.trim();
    if (name !== undefined && name !== '' && NAME_TO_NAMESPACE[name] !== undefined) {
      return { tier: 'project', namespace: NAME_TO_NAMESPACE[name] };
    }
  }
  return { tier: 'shared', namespace: null };
}

export interface MigrateScopeResult {
  total: number;
  toProject: number;
  toShared: number;
  changed: number;
  applied: boolean;
}

/** Run the migration. `apply:false` (default) is a dry-run that mutates nothing. */
export async function migrateScope(opts: {
  dbUrl: string;
  apply: boolean;
}): Promise<MigrateScopeResult> {
  const client = createClient({ url: opts.dbUrl });
  // Ensure the columns exist (idempotent) so the script is self-sufficient on an un-migrated DB.
  for (const ddl of [
    `ALTER TABLE lessons ADD COLUMN tier TEXT NOT NULL DEFAULT 'shared'`,
    `ALTER TABLE lessons ADD COLUMN namespace TEXT`,
  ]) {
    try {
      await client.execute(ddl);
    } catch {
      /* already migrated */
    }
  }
  const rs = await client.execute(`SELECT id, tags, tier, namespace FROM lessons`);
  const result: MigrateScopeResult = {
    total: rs.rows.length,
    toProject: 0,
    toShared: 0,
    changed: 0,
    applied: opts.apply,
  };
  for (const row of rs.rows) {
    const tags = JSON.parse(((row.tags as string | null) ?? '') || '[]') as string[];
    const { tier, namespace } = classifyScope(tags);
    if (tier === 'project') result.toProject += 1;
    else result.toShared += 1;
    const curTier = (row.tier as string | null) ?? 'shared';
    const curNs = (row.namespace as string | null) ?? null;
    if (curTier !== tier || curNs !== namespace) {
      result.changed += 1;
      if (opts.apply) {
        await client.execute({
          sql: `UPDATE lessons SET tier = ?, namespace = ? WHERE id = ?`,
          args: [tier, namespace, row.id as string],
        });
      }
    }
  }
  client.close();
  return result;
}
