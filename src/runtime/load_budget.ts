/**
 * T-CTX-LOOP CTX.6 (2026-05-29) — shared load-budget primitive.
 *
 * One rule applied across every per-turn-carried resource: bias the working
 * set toward "satisfies current goal" and away from "doesn't." `applyHitBudget`
 * keeps the highest-scoring items that fit within a token budget, stopping
 * at whole-item granularity. The first consumer is `recall_pre_inject` (the
 * RAG hit selector previously inlined as `selectHitsForInjection`). Future
 * resources that need token-budgeted truncation (e.g. directive aggregation
 * if/when it grows, additional context-source plugins) reuse this primitive
 * rather than reimplement the loop.
 *
 * Per `docs/load-budget.md`, this primitive is the cheapest piece of CTX.6's
 * scope; the audit doc lays out which resources have load-decisions today
 * and which gaps remain (queued as follow-up tracks).
 *
 * Imports from: nothing (pure helper).
 * Imported by: src/functions/recall_pre_inject.ts; src/runtime/load_budget.test.ts.
 */

/**
 * Minimum shape a budgetable item must carry. Concrete consumers (e.g.
 * `RecallHit`) carry richer fields; this generic only needs a score + size.
 */
export interface BudgetableItem {
  /** Higher = more relevant. Items are kept in descending score order. */
  score: number;
  /** Token (or token-approximation) cost of including this item. */
  tokenCost: number;
}

export interface BudgetResult<T> {
  /** Items kept under the budget, score-desc order. */
  kept: T[];
  /** True when the budget cut off at least one item the score filter passed. */
  truncated: boolean;
}

/**
 * Score-filter (cheap) FIRST, then accumulate by token cost until budget is
 * exhausted. Whole-item granularity — never split an item. Items below
 * `minScore` are dropped before the budget walk starts so a single
 * high-cost low-relevance item can't burn the budget.
 *
 * `tokenCost` is supplied by the caller (each resource computes its own
 * cost — RAG recall uses `Math.ceil(content.length / 4)` per the documented
 * 4-chars/token approximation). Keeping cost computation at the caller
 * avoids forcing a tokenizer dependency in this generic helper.
 */
export function applyHitBudget<T extends BudgetableItem>(
  items: readonly T[],
  minScore: number,
  maxTokens: number,
): BudgetResult<T> {
  const filtered = items.filter((i) => i.score >= minScore);
  let totalTokens = 0;
  const kept: T[] = [];
  for (const item of filtered) {
    if (totalTokens + item.tokenCost > maxTokens) break;
    kept.push(item);
    totalTokens += item.tokenCost;
  }
  return { kept, truncated: filtered.length > kept.length };
}
