/**
 * agent_bridge built-in tool — `recall`.
 *
 * Authoritative spec: the warm-agent planning notes (not retained — docs/tasks/WAB.1-architecture.md is the surviving authority) WAB.6 §"Tool
 * surface". Wraps the project-scoped RAG backend's `recall(query, k)` method.
 *
 * Responsibility:
 *   1. Validate the agent-supplied `{query, k?}` input.
 *   2. Call the injected `RagBackend.recall(query, k)`.
 *   3. Serialize the hit list into a compact string suitable for feeding
 *      back as a `tool_result.content`.
 *
 * Non-responsibility:
 *   - Does NOT own backend lifecycle. The `RagBackend` is constructed once
 *     per daemon (or per project, depending on WAB.7 wiring) and passed in.
 *   - Does NOT scope by `sessionKey`. Phase-1 RAG backends are project-scoped
 *     by construction (the libsql DB lives under the project's data dir) —
 *     a per-session scope would require a multi-tenant key column that the
 *     `RagBackend` interface does not expose today. The `ToolContext` is
 *     accepted for symmetry with the other tools, but the project scope is
 *     already baked into the backend instance.
 *
 * Output format:
 *   When the backend returns hits, we format them as a small newline-
 *   delimited list with `score: <0.xx>` + `source: <fused|semantic|lexical>`
 *   prefixes — terse enough that the model can copy-paste a quotation
 *   without first parsing JSON. When the backend returns `[]`, we surface
 *   "no results" rather than an empty string so the model doesn't silently
 *   misinterpret a successful-but-empty call as "tool errored".
 *
 * Imports from: zod, ../../../rag/types.js, ../types.js.
 * Imported by: ./index.ts (tools barrel).
 */

import { z } from 'zod';

import { resolveRecallScope } from '../../../rag/scope.js';
import type { RagBackend, RecallHit } from '../../../rag/types.js';
import type { ToolContext, ToolHandler, ToolSpec } from '../types.js';

// ---------------------------------------------------------------------------
// Input schema — mirrors the `recall` primitive's argSchema in
// `src/functions/rag.ts` (query non-empty, k bounded 1..100). Default k=5
// matches the primitive's default for parity.
// ---------------------------------------------------------------------------

const RecallInput = z.object({
  query: z.string().min(1),
  k: z.number().int().positive().max(100).optional(),
});
type RecallInputT = z.infer<typeof RecallInput>;

const DEFAULT_K = 5;

export const recallSpec: ToolSpec = {
  name: 'recall',
  description:
    'Recall lessons + memories from the project knowledge base via fused semantic + lexical search.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Natural-language query.' },
      k: {
        type: 'integer',
        description: `Max number of hits to return (default ${DEFAULT_K}, bounds 1..100).`,
        minimum: 1,
        maximum: 100,
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
  validate: (input) => RecallInput.parse(input),
};

// ---------------------------------------------------------------------------
// Handler factory — closes over the `RagBackend` instance so per-project
// or per-daemon wiring stays the caller's choice (WAB.7).
// ---------------------------------------------------------------------------

export function makeRecallHandler(backend: RagBackend): ToolHandler {
  return async (input, _ctx: ToolContext) => {
    const parsed = input as RecallInputT;
    const k = parsed.k ?? DEFAULT_K;
    const scope = await resolveRecallScope();
    const hits = await backend.recall(parsed.query, k, scope);
    if (hits.length === 0) return `no results for query=${JSON.stringify(parsed.query)}`;
    return hits.map(formatHit).join('\n---\n');
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatHit(hit: RecallHit): string {
  const tagStr = hit.lesson.tags.length > 0 ? ` tags=[${hit.lesson.tags.join(',')}]` : '';
  return [
    `id=${hit.lesson.id} score=${hit.score.toFixed(3)} source=${hit.source}${tagStr}`,
    hit.lesson.content,
  ].join('\n');
}
