/**
 * ORCH.6 — the Tier-1 grounded fallback.
 *
 * When a project task has NO matching pack, the floor is not bare-LLM — it's "answer from LOCAL authoritative
 * sources (memory + code), not web search or assumptions." This module emits that BEHAVIORAL directive (the
 * non-duplicative half); the existing `recall-pre-inject` rule supplies the actual recalled memories. PURE.
 *
 * Imported by: src/runtime/loop/orchestrate.ts (the no-match branch).
 */
import type { Facets } from '../classify.js';

/** The grounding directive for a project task with no specialized pack — local-only, no web. */
export function groundingDirective(facets: Facets): string {
  const dom = facets.domain !== undefined ? ` (${facets.domain})` : '';
  return [
    `⚓ GROUNDING — this${dom} project task has no specialized pack.`,
    'Answer from LOCAL authoritative sources, not assumptions or web search:',
    '- recall() relevant memory and READ the actual local files before answering;',
    '- do not lean on stale immediate context; cite file:line for claims.',
  ].join('\n');
}
