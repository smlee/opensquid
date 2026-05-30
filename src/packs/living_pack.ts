/**
 * DOG.5 — Living-pack version-triple convenience reader.
 *
 * Builds on LP.1's `readVersionJson` + LP.3's `resolvePackStateDir` to
 * answer the single question "what's <pack>'s base.rev version triple
 * RIGHT NOW?" without callers needing to know the underlying file layout.
 *
 * Returns null when:
 *   - the pack has no personal_revision/version.json (built-in pack the
 *     user hasn't installed; fresh-install before first lesson promotion)
 *   - OPENSQUID_HOME is set to a sandbox without the pack directory (tests)
 *
 * Returns `{base, revision}` otherwise.
 *
 * Loader (`src/packs/loader.ts`) calls this once per pack at load time
 * and folds the result into `Pack.livingVersion` for the runtime
 * dispatcher + diagnostic surface to read without re-touching disk.
 *
 * NOT a long-lived cache — every call re-reads the JSON. Caching belongs
 * to the loader (one-shot at load) + the merge cache from LP.5
 * (per-session keyed on revision-id).
 */
import { resolvePackStateDir } from './discovery.js';
import { readVersionJson } from './personal_revision.js';

export interface LivingPackVersion {
  /** semver string the pack was installed at. */
  base: string;
  /** monotonic count of promoted lessons. 0 = fresh install with no promotions. */
  revision: number;
}

/**
 * Read the user-scope personal_revision/version.json for `packId` and
 * return a `{base, revision}` triple. Returns null when:
 *  - the pack isn't user-installed (no `~/.opensquid/packs/<id>/` dir)
 *  - version.json is absent (fresh install before any promotion)
 *
 * Throws on malformed JSON (LP.1 contract — engine-written file,
 * unexpected content is a real bug worth surfacing).
 */
export async function getLivingPackVersion(packId: string): Promise<LivingPackVersion | null> {
  const stateDir = resolvePackStateDir(packId, 'user');
  const version = await readVersionJson(stateDir);
  if (version === null) return null;
  return { base: version.base_version, revision: version.personal_revision_id };
}
