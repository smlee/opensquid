/**
 * DOG.3 — seed_lessons -> engine.lessonCreate ingest.
 *
 * Wraps the engine's `lesson.create` JSON-RPC (pack-authored variant) so
 * each `SeedLesson` declared in a pack's manifest lands in the engine's
 * lessons table at load time:
 *   - `authored_by: 'pack'` + `pack_id` — engine treats pack-authored
 *     lessons as eviction-immune (mirrors user-authored behaviour per
 *     `feedback_user_authored_lessons_immune`).
 *   - `seed_as_promoted: true` — bypasses the pending->promoted gate so
 *     seed knowledge is immediately recall-eligible (matches the v1.1
 *     pack-author surface in `src/engine/types.ts`).
 *   - `external_id: pack-seed:<sha256-24>` — stable across re-ingestion
 *     so the engine UPSERTs (`updated: true`) instead of duplicating.
 *
 * Fire-and-forget contract: per-seed failures are COLLECTED, never
 * thrown. `loadPack` invokes this in a `void` context so a missing or
 * down engine NEVER blocks pack load — the seeds simply aren't queryable
 * until the next load with an engine present.
 *
 * Per-seed error isolation: one failing seed does not abort the rest.
 */
import { createHash } from 'node:crypto';

import type { EngineClient } from '../engine/client.js';
import type { SeedLesson } from './schemas/manifest.js';

export interface IngestResult {
  ingested: number;
  skipped: number;
  failed: readonly { title: string; error: string }[];
}

/**
 * Ingest `seeds` into the engine. Returns `{ingested, skipped, failed}`:
 *   - `ingested`: seeds that the engine accepted as NEW rows
 *     (`result.updated === false`)
 *   - `skipped`:  seeds the engine UPSERTed onto an existing row
 *     (`result.updated === true`)  — idempotent re-ingest
 *   - `failed`:   per-seed RPC errors (engine down, validation error,
 *     network blip). Never thrown — callers log.
 */
export async function ingestSeedLessons(
  packName: string,
  packVersion: string,
  seeds: readonly SeedLesson[],
  engine: EngineClient,
): Promise<IngestResult> {
  let ingested = 0;
  let skipped = 0;
  const failed: { title: string; error: string }[] = [];

  for (const seed of seeds) {
    try {
      const result = await engine.lessonCreate({
        description: seed.title,
        body: seed.body,
        authored_by: 'pack',
        pack_id: packName,
        external_id: makeExternalId(packName, packVersion, seed.title),
        seed_as_promoted: true,
      });
      if (result.updated) skipped += 1;
      else ingested += 1;
    } catch (e) {
      failed.push({
        title: seed.title,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return { ingested, skipped, failed };
}

/**
 * sha256-derived external_id for engine UPSERT.
 *
 * Stable across opensquid processes for the same (pack@version + title),
 * collision-resistant under pack-author discipline (no two seeds in one
 * pack share a title). Different packs that happen to use the same title
 * produce distinct external_ids because pack name is part of the input.
 */
export function makeExternalId(packName: string, packVersion: string, title: string): string {
  const hash = createHash('sha256').update(`${packName}@${packVersion}|${title}`).digest('hex');
  return `pack-seed:${hash.slice(0, 24)}`;
}
