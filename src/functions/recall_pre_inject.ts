/**
 * `recall_pre_inject` primitive — pre-inject top-K memory hits into the
 * current `UserPromptSubmit` context.
 *
 * Composes the same recall path as the `recall` MCP tool: pulls the user's
 * prompt from the `prompt_submit` event, queries the configured RAG backend,
 * filters by `min_score`, applies a whole-hit token-budget guard, and emits
 * the formatted hit list as a `RuleResult.inject_context` payload.
 *
 * Cross-harness portability: this primitive is harness-AGNOSTIC. It only
 * returns structured data (a `content: string`). The host-specific framing
 * (Claude Code's `hookSpecificOutput.additionalContext` JSON envelope,
 * Cursor's equivalent, Codex CLI's equivalent) lives in the per-host hook
 * binary (currently `src/runtime/hooks/user-prompt-submit.ts`). Other hooks
 * that emit this kind of result get a stderr warning at dispatch time
 * (`dispatch.ts`) — only `UserPromptSubmit` actually writes it out.
 *
 * Special evaluator integration: returning the shape
 * `{ kind: 'inject_context', content }` from this primitive makes the
 * evaluator (`evaluator.ts`) treat it as a TERMINAL `RuleResult` — the same
 * pattern the `verdict` primitive uses. No bindings, no fall-through. An
 * empty / no-hit recall returns `null`, which the evaluator's `isEmpty`
 * branch handles as no-verdict.
 *
 * Token-budget guard model (per task spec G.4):
 *   - Crude estimate `Math.ceil(content.length / 4)` (4 chars/token); real
 *     tokenizer is a deliberate follow-up. 4000 conservative for Claude.
 *   - Score filter (cheaper signal) runs FIRST, then the token guard. This
 *     keeps the loop bounded even if the backend returns many low-quality
 *     hits — they're filtered before we start counting tokens.
 *   - Whole-hit granularity only — never split a hit mid-string. If hit N+1
 *     would push us past `max_tokens`, we keep N and stop.
 *
 * Imports from: zod, ../rag/types.js, ../runtime/result.js, ./registry.js.
 * Imported by: src/runtime/bootstrap.ts (registry wiring).
 */

import { z } from 'zod';

import type { RagBackend, RecallHit } from '../rag/types.js';
import { err, ok } from '../runtime/result.js';

import type { FunctionRegistry } from './registry.js';

// ---------------------------------------------------------------------------
// Zod arg schema — defaults locked at Phase-2 (learn) per task spec G.4.
// `.strict()` rejects unexpected YAML keys so typos surface as `arg_invalid`.
// ---------------------------------------------------------------------------

const RecallPreInjectArgs = z
  .object({
    k: z.number().int().min(1).max(20).default(5),
    min_score: z.number().min(0).max(1).default(0.4),
    max_tokens: z.number().int().min(100).max(20000).default(4000),
    min_prompt_chars: z.number().int().min(0).max(10000).default(20),
    query_field: z.enum(['prompt', 'user_prompt']).default('prompt'),
  })
  .strict();

/** Crude token estimate. ~4 chars/token is the documented approximation. */
function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

/** Apply the score filter first (cheap), then the whole-hit token-budget guard. */
function selectHitsForInjection(
  hits: RecallHit[],
  minScore: number,
  maxTokens: number,
): { kept: RecallHit[]; truncated: boolean } {
  const filtered = hits.filter((h) => h.score >= minScore);
  let totalTokens = 0;
  const kept: RecallHit[] = [];
  for (const h of filtered) {
    const t = estimateTokens(h.lesson.content);
    if (totalTokens + t > maxTokens) break;
    kept.push(h);
    totalTokens += t;
  }
  return { kept, truncated: filtered.length > kept.length };
}

/** Format the kept hits as a single string ready for context injection. */
function formatHitsForInjection(hits: RecallHit[], query: string, truncated: boolean): string {
  const headerQuery = query.length > 80 ? `${query.slice(0, 80)}…` : query;
  const truncatedNote = truncated ? ' (truncated by token budget)' : '';
  const header = `[opensquid recall — top ${String(hits.length)} memories for "${headerQuery}"${truncatedNote}]`;
  const body = hits
    .map(
      (h, i) =>
        `${String(i + 1)}. (score=${h.score.toFixed(3)}, source=${h.source})\n${h.lesson.content}`,
    )
    .join('\n\n');
  return `${header}\n\n${body}\n\n[end opensquid recall]`;
}

export function registerRecallPreInjectFunction(
  registry: FunctionRegistry,
  backend: RagBackend,
): void {
  registry.register({
    name: 'recall_pre_inject',
    argSchema: RecallPreInjectArgs,
    // Backend recall is the same call as `recall`; same durability profile.
    durable: true,
    memoizable: true,
    costEstimateMs: 50,
    execute: async (args, ctx) => {
      // Zod `.default()` is applied by the registry's `safeParse` before
      // `execute` runs, but `FunctionDef<TArgs>` infers `TArgs` from the
      // schema's INPUT type — where defaulted fields stay optional. The
      // `??` fallbacks below mirror the schema defaults so TS narrows.
      // Keeps the surface identical to the existing rag.ts pattern.
      const k = args.k ?? 5;
      const minScore = args.min_score ?? 0.4;
      const maxTokens = args.max_tokens ?? 4000;
      const minPromptChars = args.min_prompt_chars ?? 20;
      // `query_field` reserved for future host adapters that surface the
      // prompt under a different field name; the PromptSubmitEvent shape
      // has only `prompt`, so 'user_prompt' is forward-compat scaffolding.
      void args.query_field;

      // Only meaningful on `prompt_submit` events. Other event kinds return
      // null → evaluator treats as empty → no-verdict (no injection). This
      // is the per-primitive guard; the dispatcher-level warning catches
      // misconfiguration where a pack registers this on the wrong trigger.
      if (ctx.event.kind !== 'prompt_submit') return ok(null);
      const query = ctx.event.prompt;
      if (query.length < minPromptChars) return ok(null);

      let hits: RecallHit[];
      try {
        hits = await backend.recall(query, k);
      } catch (e) {
        return err({
          kind: 'runtime',
          message: `recall_pre_inject(${query}): ${String(e)}`,
          cause: e,
        });
      }
      const { kept, truncated } = selectHitsForInjection(hits, minScore, maxTokens);
      if (kept.length === 0) return ok(null);
      const content = formatHitsForInjection(kept, query, truncated);
      return ok({ kind: 'inject_context' as const, content });
    },
  });
}
