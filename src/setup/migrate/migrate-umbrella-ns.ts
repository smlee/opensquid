/**
 * Re-namespace project-tier memory rows from the legacy UMBRELLA-id string to the per-repo project
 * UUID (T-umbrella-confine-to-chat UCC.3). Before UCC.1, recall keyed memory on the chat umbrella id
 * (e.g. `"loop"`, `"raumpilates"`); after UCC.1 it keys on the nearest `.opensquid/project.json` UUID.
 * This one-time migration re-points existing rows so they remain recallable.
 *
 * The umbrella→UUID map is built from `channels.json` (umbrella → its ROOT member → that dir's marker
 * UUID) INSIDE this tool — a migration-time read only; the runtime process layer never reads
 * `channels.json`. Additive, idempotent (a row already at its UUID is skipped), DRY-RUN by default —
 * mutate only with `apply:true`, on a COPY of `~/.opensquid/rag.sqlite` first. NEVER deletes a row
 * (the never-delete axiom); conserves counts.
 *
 * Known limitation: the umbrella string does not encode member origin, so every `"loop"` row maps to
 * loop's UUID even if it was authored from the opensquid sub-repo — acceptable under the user lock
 * "all planning is in loop".
 *
 * Imports from: @libsql/client, ../../channels/routing.js, ../../runtime/paths.js.
 * Imported by: src/cli.ts (the `migrate-umbrella-ns` command) + the test.
 */
import { createClient } from '@libsql/client';

import { loadChannelsConfig } from '../../channels/routing.js';
import { resolveProjectMarker } from '../../runtime/paths.js';

export interface MigrateUmbrellaNsResult {
  total: number;
  changed: number;
  applied: boolean;
}

/**
 * Build the umbrella-id → root-member marker UUID map from `channels.json`. The ROOT member is the
 * SHORTEST member path (the umbrella root), matching the retired `umbrellaRootFor` rule. An umbrella
 * whose root has no `.opensquid/project.json` marker is omitted (its rows are left untouched — never
 * mapped to a guessed UUID). Pure-ish: reads channels.json + the marker files, no mutation.
 */
export async function buildUmbrellaUuidMap(): Promise<Record<string, string>> {
  const cfg = await loadChannelsConfig();
  const map: Record<string, string> = {};
  for (const u of cfg?.umbrellas ?? []) {
    const root = [...u.members].sort((a, b) => a.length - b.length)[0];
    if (root === undefined) continue;
    const marker = await resolveProjectMarker(root);
    if (marker !== null) map[u.id] = marker.uuid;
  }
  return map;
}

/**
 * Re-namespace project-tier rows whose `namespace` is an umbrella id → its marker UUID.
 * `apply:false` (default) is a dry-run that mutates nothing. Idempotent: a row already at its UUID
 * (or whose namespace is not a known umbrella id) is skipped.
 */
export async function migrateUmbrellaNs(opts: {
  dbUrl: string;
  apply: boolean;
  umbrellaToUuid?: Record<string, string>;
}): Promise<MigrateUmbrellaNsResult> {
  const umbrellaToUuid = opts.umbrellaToUuid ?? (await buildUmbrellaUuidMap());
  const client = createClient({ url: opts.dbUrl });
  const rs = await client.execute(
    `SELECT id, namespace FROM lessons WHERE tier = 'project' AND namespace IS NOT NULL`,
  );
  const result: MigrateUmbrellaNsResult = {
    total: rs.rows.length,
    changed: 0,
    applied: opts.apply,
  };
  for (const row of rs.rows) {
    const ns = row.namespace as string;
    const uuid = umbrellaToUuid[ns];
    if (uuid === undefined || uuid === ns) continue; // unmapped or already-UUID → skip (idempotent)
    result.changed += 1;
    if (opts.apply) {
      await client.execute({
        sql: `UPDATE lessons SET namespace = ? WHERE id = ?`,
        args: [uuid, row.id as string],
      });
    }
  }
  client.close();
  return result;
}
