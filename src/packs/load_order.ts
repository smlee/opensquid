/**
 * Pack load-order: scope-precedence + alphabetical-within-scope stable sort.
 *
 * Per `docs/opensquid-real-design.md` §"Pack format" scope levels. Scope is a
 * LAYERING HINT — universal sets baseline conventions, project pins
 * project-specific overrides, with three intermediate layers. The runtime
 * walks the sorted list when applying load conditions, surfacing rules, and
 * accumulating verdicts; ordering matters because later packs see prior
 * packs' state in the same evaluation window.
 *
 * The order is intentionally fixed (universal → domain → specialty → workflow
 * → project) rather than user-configurable per pack: pack authors declare
 * scope, not priority. Two packs at the same scope are sorted alphabetically
 * by `name` for determinism — output is byte-identical across runs given the
 * same input set. Same-scope name collisions are NOT auto-resolved here;
 * they surface via `validateUniqueSkillNames` (Task 2.5) at load-orchestrator
 * time and require an explicit `extends:` or rename per design doc
 * §"Conflict resolution policy".
 *
 * Purity contract: `sortPacksByScope` never mutates its input array (spreads
 * first), never mutates pack objects (sort is by-reference comparison only),
 * and is referentially transparent — calling it twice with the same input
 * produces the same output. This matters for the load-orchestrator audit
 * trail: re-sorting on every event must not surface phantom diffs.
 *
 * Imports from: runtime/types.ts (Pack, Scope).
 * Imported by: future load-orchestrator (Phase 5 integration); re-exported
 * via packs/index.ts.
 */

import type { Pack, Scope } from '../runtime/types.js';

// Scope index keyed off the runtime `Scope` literal so a future scope
// addition fails the typechecker until this map is updated (rather than
// silently returning `undefined - 0 = NaN` at sort time).
const SCOPE_ORDER: Record<Scope, number> = {
  universal: 0,
  domain: 1,
  specialty: 2,
  workflow: 3,
  project: 4,
};

export function sortPacksByScope(packs: Pack[]): Pack[] {
  // Spread before sort — `Array.prototype.sort` mutates in place. The
  // load-orchestrator passes its internal pack list straight through and we
  // must not mutate the source-of-truth array.
  return [...packs].sort((a, b) => {
    const d = SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope];
    if (d !== 0) return d;
    return a.name.localeCompare(b.name);
  });
}

// PT.1 — de-duplicate a composed pack list by `name`, keeping the FIRST
// occurrence. `loadActivePacks` composes `[...user, ...project]`, so a pack
// declared active in BOTH scopes (the tri-state model's illegal "in both"
// state — reachable via chat-setup's user-list write, a manual edit, or a
// `pack set` mid-crash) would otherwise appear twice: it would load twice and
// `validateUniqueSkillNames` would flag every one of its skills as
// "claimed by multiple packs" (the pack colliding with its own duplicate).
// First-occurrence-wins + the user→project compose order = USER WINS ("global
// dominates": a pack active at user scope loads everywhere; a redundant
// project entry is dropped, never double-loaded). Pure: never mutates input.
export function dedupePacksByName(packs: Pack[]): Pack[] {
  const seen = new Set<string>();
  return packs.filter((p) => {
    if (seen.has(p.name)) return false;
    seen.add(p.name);
    return true;
  });
}
