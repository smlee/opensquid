/**
 * LRU parse cache for `if:` expression ASTs — Task H.1.5.
 *
 * Key = trimmed expression string. Value = `ASTNode` from `cstToAst()`.
 * Two expressions with the same trimmed string parse to the same AST
 * regardless of binding context (the AST is binding-independent), so the
 * trimmed-string key is collision-safe (pre-research §6.2). DO NOT include
 * binding schema in the key — that would defeat the cache's purpose and
 * collapse hit-rate to ~0 because event-data bindings vary per call.
 *
 * Sizing: `max: 256` entries. Projected 12-month skill growth caps at ~100
 * unique `if:` clauses across all installed packs (pre-research §6.1);
 * 256 is 2.5× that with ~256KB memory ceiling. Bump later if telemetry
 * shows eviction pressure.
 *
 * Lifecycle: process-lifetime cache, no invalidation in v1. Process restart
 * clears naturally. If/when skill yaml hot-reload lands, callers MUST invoke
 * `clear()` on reload — otherwise a stale AST will keep being evaluated
 * against new binding schemas.
 *
 * lru-cache v11 API notes:
 *   - `cache.size` is a property (not a method); `cache.max` is read-only.
 *   - Hit/miss counters are NOT exposed; wrap `get`/`set` with manual
 *     counting if perf debugging needs them. Skipped in v1 per §6.4.
 */

import { LRUCache } from 'lru-cache';

import type { ASTNode } from './ast.js';

/** Max cached parse entries. See pre-research §6.1 for sizing rationale. */
export const MAX_ENTRIES = 256;

const cache = new LRUCache<string, ASTNode>({ max: MAX_ENTRIES });

/** Look up a cached AST by its trimmed expression-string key. */
export function getCached(key: string): ASTNode | undefined {
  return cache.get(key);
}

/** Store a freshly-parsed AST under its trimmed expression-string key. */
export function setCached(key: string, ast: ASTNode): void {
  cache.set(key, ast);
}

/** Cache occupancy snapshot. `size` is current entries; `max` is the cap. */
export function stats(): { size: number; max: number } {
  return { size: cache.size, max: MAX_ENTRIES };
}

/** Drop all entries. Call from any hot-reload path (none in v1). */
export function clear(): void {
  cache.clear();
}
