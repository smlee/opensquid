/**
 * ORCH.1 — helpers over a pack's `serves` declaration (the frozen facet vocabulary, `schemas/pack_v2.ts`).
 *
 * `serves` is a single block OR a non-empty list of blocks; the orchestrator's matcher (ORCH.3) works over a
 * normalized block array and each block's flat facet map. Kept PURE + tiny so the matcher stays a pure function.
 *
 * Imported by: src/packs/match.ts (ORCH.3).
 */
import type { ServesBlock } from './schemas/pack_v2.js';

/** Normalize the `serves` union to a block array: undefined → [], a single block → [block], a list → as-is. */
export function normalizeServes(s: ServesBlock | ServesBlock[] | undefined): ServesBlock[] {
  if (s === undefined) return [];
  return Array.isArray(s) ? s : [s];
}

/**
 * Flatten a block to its facet map (intent/domain/stakes + any free qualifiers), dropping undefined optionals.
 * Every retained value is a string (the enums are string-valued, qualifiers are `.catchall(z.string())`), so the
 * matcher can compare facet maps key-for-key.
 */
export function servesFacets(b: ServesBlock): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(b)) if (typeof v === 'string') out[k] = v;
  return out;
}
