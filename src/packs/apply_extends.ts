/**
 * `extends:` mechanism — layer a child pack over a parent without forking.
 *
 * Per `docs/opensquid-real-design.md` §"Manifest fields" (`extends` row) and
 * §"Conflict resolution policy". `extends:` is the EXPLICIT override path:
 * the user opts into "child wins on field collision, child skills override
 * parent skills by name" rather than letting the runtime silently pick a
 * winner. It is the named alternative to the forbidden auto-resolve.
 *
 * Merge semantics (locked):
 *   - Top-level scalar fields (name, version, scope, goal, description,
 *     `extends`) — child value replaces parent value. `description` falls
 *     back to parent only when the child supplied the empty string default
 *     (so an "I forgot to write one" child doesn't blank out a real parent
 *     description); explicit child string wins.
 *   - List fields (requires, conflicts) — child REPLACES parent. Union
 *     semantics would silently re-introduce parent dependencies a child
 *     wanted to drop; replacement keeps `extends:` predictable.
 *   - `evolves` — child wins. A child that wants the wedge gate off needs
 *     to be able to turn it off regardless of parent default.
 *   - `skills` — merged by `name`. Same-named skill in child replaces
 *     parent's; new skills append; parent-only skills carry through.
 *
 * Defensive deep-clone: `JSON.parse(JSON.stringify(parent))` strips Dates,
 * RegExps, functions, and `undefined`. `Pack` is data-only (Zod-validated
 * plain objects with strings / numbers / booleans / nested objects / arrays),
 * so the round-trip is lossless. Documented here so a future field addition
 * doesn't accidentally break the contract — adding a `Date` field to `Pack`
 * means choosing a different clone strategy. Cloning the PARENT (not the
 * child) is intentional: the parent provides the base structure, and we
 * spend most of the merge code mutating that clone with child values.
 *
 * `detectExtendsCycle` walks the `extends` chain starting from each pack
 * and flags any pack whose chain re-enters itself. Returns the set of
 * cycle-START names; callers (validation layer) decide whether to error
 * or surface to the user. Out-of-scope: `extends:` pointing at a missing
 * parent — that's a validation concern, not a cycle concern; the caller
 * (loader) handles missing parents before invoking this function.
 *
 * Imports from: runtime/types.ts (Pack).
 * Imported by: future load-orchestrator (Phase 5 integration); re-exported
 * via packs/index.ts.
 */

import type { Pack } from '../runtime/types.js';

export function applyExtends(child: Pack, parent: Pack): Pack {
  // Deep-clone parent so the merged result shares no reference with either
  // input. Caller can mutate `merged` freely without leaking back. See
  // file-level comment for why JSON round-trip is the right clone choice
  // for a data-only schema.
  const merged: Pack = JSON.parse(JSON.stringify(parent)) as Pack;

  // Child wins on top-level scalars. `description` keeps parent ONLY when
  // child supplied the empty-string default; an explicit child "" would be
  // unusual but a non-empty explicit child string always wins.
  merged.name = child.name;
  merged.version = child.version;
  merged.scope = child.scope;
  merged.goal = child.goal;
  merged.description = child.description !== '' ? child.description : merged.description;
  merged.extends = child.extends;
  merged.evolves = child.evolves;

  // Lists replace, don't union. Spread to defensive-copy in case the child
  // is later mutated by a caller — `merged.requires === child.requires`
  // would create a shared reference and reintroduce mutation hazards.
  merged.requires = [...child.requires];
  merged.conflicts = [...child.conflicts];

  // Skills: merge by name. Map seed from parent (already cloned), then
  // every child skill overwrites or appends. Iteration order of the final
  // Map is insertion-order: parent-only skills first, then any
  // child-added new names in child's declared order, with overridden names
  // retaining their parent position.
  const skillMap = new Map(merged.skills.map((s) => [s.name, s]));
  for (const s of child.skills) skillMap.set(s.name, s);
  merged.skills = [...skillMap.values()];

  return merged;
}

export function detectExtendsCycle(packs: Pack[]): string[] {
  const byName = new Map(packs.map((p) => [p.name, p]));
  const cycles: string[] = [];

  // Each pack starts its own walk. Self-extends counts as a cycle the moment
  // the walker re-visits the starting node. We track `visited` per-start so
  // legitimate diamond-shape chains (A→B, C→B) don't false-positive.
  for (const start of packs) {
    const visited = new Set<string>();
    let cur: Pack | undefined = start;
    while (cur?.extends) {
      if (visited.has(cur.name)) {
        cycles.push(start.name);
        break;
      }
      visited.add(cur.name);
      cur = byName.get(cur.extends);
    }
  }

  return cycles;
}
