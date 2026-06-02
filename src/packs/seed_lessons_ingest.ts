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
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';

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
  packDir: string,
): Promise<IngestResult> {
  let ingested = 0;
  let skipped = 0;
  const failed: { title: string; error: string }[] = [];

  for (const seed of seeds) {
    try {
      const body = await resolveSeedBody(seed, packDir);
      const result = await engine.lessonCreate({
        description: seed.title,
        body,
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
 * Resolve a seed's body: inline `body` wins; otherwise read `body_path` as a
 * file relative to the pack directory. The schema (`SeedLesson` refine)
 * guarantees exactly one is set. body_path is path-traversal-confined to the
 * pack dir — an absolute path or one that escapes the pack root throws (caught
 * per-seed by the caller, isolating one bad seed from the rest). An
 * empty/whitespace-only file throws too (engine requires a non-empty body).
 */
async function resolveSeedBody(seed: SeedLesson, packDir: string): Promise<string> {
  if (seed.body !== undefined) return seed.body;
  const rel = seed.body_path;
  if (rel === undefined) {
    // Unreachable given the schema XOR refine, but fail loud rather than send
    // an empty body to the engine.
    throw new Error('seed_lesson has neither body nor body_path');
  }
  if (isAbsolute(rel)) {
    throw new Error(`seed_lesson body_path must be pack-relative, got absolute: ${rel}`);
  }
  const root = resolve(packDir);
  const abs = resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error(`seed_lesson body_path escapes the pack dir: ${rel}`);
  }
  const content = (await readFile(abs, 'utf8')).trim();
  if (content.length === 0) {
    throw new Error(`seed_lesson body_path resolved to an empty file: ${rel}`);
  }
  return content;
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
