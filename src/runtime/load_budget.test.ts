/**
 * T-CTX-LOOP CTX.6 — unit tests for `applyHitBudget`.
 *
 * The primitive is shared across resources that need score-filtered,
 * token-budgeted, whole-item-granular truncation. First consumer is
 * `recall_pre_inject` (previously had this loop inlined as
 * `selectHitsForInjection`).
 */

import { describe, expect, it } from 'vitest';

import { applyHitBudget, type BudgetableItem } from './load_budget.js';

interface TestItem extends BudgetableItem {
  name: string;
}

function item(name: string, score: number, tokenCost: number): TestItem {
  return { name, score, tokenCost };
}

describe('applyHitBudget', () => {
  it('keeps items above minScore and under budget; returns kept order preserved', () => {
    const r = applyHitBudget(
      [item('a', 0.9, 100), item('b', 0.8, 100), item('c', 0.7, 100)],
      0.5,
      300,
    );
    expect(r.kept.map((i) => i.name)).toEqual(['a', 'b', 'c']);
    expect(r.truncated).toBe(false);
  });

  it('drops items below minScore BEFORE the budget walk', () => {
    const r = applyHitBudget(
      [item('a', 0.9, 100), item('b', 0.2, 100), item('c', 0.7, 100)],
      0.5,
      300,
    );
    expect(r.kept.map((i) => i.name)).toEqual(['a', 'c']);
    expect(r.truncated).toBe(false);
  });

  it('marks truncated=true when at least one score-passing item is dropped by budget', () => {
    const r = applyHitBudget(
      [item('a', 0.9, 200), item('b', 0.8, 200), item('c', 0.7, 200)],
      0.5,
      300,
    );
    expect(r.kept.map((i) => i.name)).toEqual(['a']);
    expect(r.truncated).toBe(true);
  });

  it('truncated=false when ONLY score-filtered items were dropped', () => {
    const r = applyHitBudget(
      [item('a', 0.9, 50), item('b', 0.3, 5000), item('c', 0.7, 50)],
      0.5,
      300,
    );
    expect(r.kept.map((i) => i.name)).toEqual(['a', 'c']);
    expect(r.truncated).toBe(false);
  });

  it('returns empty kept + truncated=false when ALL items are below minScore', () => {
    const r = applyHitBudget([item('a', 0.1, 50), item('b', 0.2, 50)], 0.5, 300);
    expect(r.kept).toEqual([]);
    expect(r.truncated).toBe(false);
  });

  it('handles empty input', () => {
    const r = applyHitBudget([], 0.5, 300);
    expect(r.kept).toEqual([]);
    expect(r.truncated).toBe(false);
  });

  it('whole-item granularity: an item that exactly fits is kept; an item one token over stops the walk', () => {
    const r = applyHitBudget(
      [item('a', 0.9, 200), item('b', 0.8, 100), item('c', 0.7, 1)],
      0.5,
      300,
    );
    expect(r.kept.map((i) => i.name)).toEqual(['a', 'b']);
    expect(r.truncated).toBe(true);
  });
});
