/**
 * ORCH.3 — `matchPacks(facets, packs)`: the catalog matcher of the hard-coded prompt router.
 *
 * A pack's `serves` block MATCHES a turn iff every facet key the block sets equals the same key on the turn
 * (subset match; keys absent from the block are wildcards). Specificity = the number of keys the matching block
 * sets; the MOST-SPECIFIC pack wins. When >1 pack share the top specificity the tie is SURFACED (the caller —
 * ORCH.5 — resolves it via `orchestrator.json` / asks). PURE.
 *
 * Imports: ./serves (normalize/flatten), ./schemas/pack_v2, ../runtime/classify (Facets).
 * Imported by: src/runtime/loop/orchestrate.ts (ORCH.5).
 */
import { normalizeServes, servesFacets } from './serves.js';
import { contains } from './taxonomy.js';

import type { PackV2 } from './schemas/pack_v2.js';
import type { Facets } from '../runtime/classify.js';

/**
 * Subset match with HIERARCHICAL containment on the taxonomy axes. Every key the `block` sets must be satisfied by
 * the turn `f`: the `domain` (and other dotted axes) match by CONTAINMENT — the block's node must contain the
 * turn's path (at-or-below it: a `coding` pack fires a `coding.frontend` turn, never the reverse); every other key
 * matches by equality. Returns the specificity (key count + the matched domain's DEPTH, so a deeper node outranks
 * a shallower one for most-specific-wins) or null.
 */
const HIERARCHICAL = new Set(['domain', 'lang', 'framework']);
function blockMatch(block: Record<string, string>, f: Record<string, string>): number | null {
  let depth = 0;
  for (const [k, v] of Object.entries(block)) {
    if (HIERARCHICAL.has(k)) {
      const path = f[k];
      if (path === undefined || !contains(v, path)) return null;
      depth += v.split('.').length; // deeper declared node ⇒ more specific
    } else if (f[k] !== v) {
      return null;
    }
  }
  return Object.keys(block).length + depth;
}

/** The turn's facets as a plain string map (undefined optionals omitted — no phantom keys). */
function facetMap(f: Facets): Record<string, string> {
  const m: Record<string, string> = { intent: f.intent };
  if (f.domain !== undefined) m.domain = f.domain; // a DOTTED path (root + derived sub-domain)
  if (f.stakes !== undefined) m.stakes = f.stakes;
  return m;
}

/**
 * Match `facets` against the candidate packs. Returns the single winner (`pack`) when one pack is strictly the
 * most specific, plus the full `candidates` set sharing the top specificity (length>1 ⇒ a tie for the caller).
 */
export function matchPacks(
  facets: Facets,
  packs: PackV2[],
): { pack?: PackV2; candidates: PackV2[] } {
  const fm = facetMap(facets);
  const scored = packs
    .map((pack) => {
      let best: number | null = null;
      for (const block of normalizeServes(pack.serves)) {
        const s = blockMatch(servesFacets(block), fm);
        if (s !== null && (best === null || s > best)) best = s;
      }
      return best === null ? null : { pack, specificity: best };
    })
    .filter((x): x is { pack: PackV2; specificity: number } => x !== null);
  if (scored.length === 0) return { candidates: [] };
  const top = Math.max(...scored.map((s) => s.specificity));
  const candidates = scored.filter((s) => s.specificity === top).map((s) => s.pack);
  const [first] = candidates;
  return candidates.length === 1 && first !== undefined
    ? { pack: first, candidates }
    : { candidates };
}
