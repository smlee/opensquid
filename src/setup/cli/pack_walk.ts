/**
 * The single owner of the installed-set packs/ walk skeleton (wg-a3e928b8255b).
 *
 * Three CLI enumerators (`triggers_state.enumeratePacks`,
 * `limits_state.enumeratePackRateLimits`, `permissions_state.enumerateManifests`)
 * used to each re-implement the same readdir→sort→dotfile-skip→stat→isDirectory
 * walk plus their own per-pack failure handling — and they diverged: one copy
 * left the per-pack load UNGUARDED, so a single malformed/backup pack under
 * `~/.opensquid/packs/` crashed `schedule list` / `triggers list`. This helper
 * owns the walk + the per-pack guard ONCE; the three enumerators are thin
 * callers passing only their loader callback, so the divergence cannot recur.
 *
 * Resilience contract (fail-SOFT — this is the INSTALLED-SET scan, not the
 * user-opted-in active.json set, which stays fail-LOUD in packs/discovery.ts):
 *   - packs dir ENOENT                      → [] (no installed packs).
 *   - entry is a dotfile / not a directory  → skipped.
 *   - dir has no `manifest.yaml`            → SILENT skip ("not a pack").
 *   - dir HAS a manifest but `loadOne` throws (Zod / YAML / ENOENT from a
 *     deeper read such as a missing skill.yaml) → skipped with ONE stderr
 *     `console.warn`. The scan never throws past a single broken pack.
 *
 * The is-a-pack test MUST be the manifest probe, never the thrown error code:
 * a missing `manifest.yaml` and a missing `skill.yaml` BOTH surface as readFile
 * ENOENT (packs/yaml.ts), and `loadSkillsDir` calls parseYamlFile unguarded
 * (packs/loader.ts), so a code-branch would silently drop a present-but-broken
 * pack — the exact hole this fix closes.
 *
 * Imports from: node:fs/promises, node:path.
 * Imported by: setup/cli/{triggers_state,limits_state,permissions_state}.ts.
 */

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export async function walkPacksDir<T>(
  packsDir: string,
  loadOne: (dir: string, name: string) => Promise<T>,
): Promise<T[]> {
  let entries: string[];
  try {
    entries = await readdir(packsDir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  entries.sort();
  const out: T[] = [];
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const dir = join(packsDir, name);
    let st;
    try {
      st = await stat(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    // is-a-pack == has manifest.yaml; cannot be the thrown ENOENT (a missing
    // skill.yaml throws ENOENT too) → probe the manifest first.
    try {
      await stat(join(dir, 'manifest.yaml'));
    } catch {
      continue; // no manifest → not a pack → silent skip
    }
    // Manifest present → this IS a pack; ANY load failure = a BROKEN pack → warn + skip.
    try {
      out.push(await loadOne(dir, name));
    } catch (e) {
      console.warn(
        `opensquid: skipping pack "${name}" — failed to load: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return out;
}
