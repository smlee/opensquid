/**
 * ORCH.7 — list the INSTALLED v2 packs (the orchestrator's candidate catalog).
 *
 * The orchestrator must be able to turn ON a pack that isn't active yet, so its catalog is all INSTALLED v2 packs
 * (`pack.yaml` under each scope's `packs/` dir + the builtin root), not just the `active.json` set. FAIL-OPEN scan:
 * a dir without `pack.yaml` (ENOENT) or a malformed pack is SKIPPED — a discovery scan must never break the hook
 * (contrast `loadActiveEntry`, which fails loud because an `active.json` entry MUST resolve).
 *
 * Per-prompt scan is correct + simple (the hook runs per prompt); session-start persistence is a later optimization.
 *
 * Imported by: src/runtime/hooks/user-prompt-submit.ts (the orchestrator catalog source).
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  resolveBuiltinScopeRoot,
  resolveProjectScopeRoot,
  resolveUserScopeRoot,
} from '../runtime/paths.js';

import { loadPackV2, type LoadedPackV2 } from './loader_v2.js';

/** Load every `pack.yaml`-bearing subdir of `base`; skip non-pack/malformed dirs (fail-open). */
async function scanBase(base: string): Promise<LoadedPackV2[]> {
  let dirs: string[];
  try {
    dirs = (await readdir(base, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return []; // ENOENT base → none
  }
  const out: LoadedPackV2[] = [];
  for (const name of dirs) {
    try {
      out.push(await loadPackV2(join(base, name)));
    } catch {
      /* no pack.yaml (ENOENT) or malformed → skip (fail-open scan; never break the hook) */
    }
  }
  return out;
}

/** All INSTALLED v2 packs (`pack.yaml`), scope-first then builtin, deduped by name (first occurrence wins). */
export async function listInstalledV2Packs(cwd: string): Promise<LoadedPackV2[]> {
  const projectRoot = await resolveProjectScopeRoot(cwd);
  const bases = [
    join(resolveUserScopeRoot(), 'packs'),
    ...(projectRoot !== null ? [join(projectRoot, 'packs')] : []),
    resolveBuiltinScopeRoot(),
  ];
  const seen = new Set<string>();
  const out: LoadedPackV2[] = [];
  for (const base of bases) {
    for (const loaded of await scanBase(base)) {
      if (!seen.has(loaded.pack.name)) {
        seen.add(loaded.pack.name);
        out.push(loaded);
      }
    }
  }
  return out;
}
