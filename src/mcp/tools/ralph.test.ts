import { describe, it, expect } from 'vitest';
import { DecisionClassifySchema, handleDecisionClassify } from './ralph.js';

interface Verdict {
  verdict: string;
  confidence: number;
  source: string;
  matched: string[];
}
const classify = (decision: string): Verdict =>
  JSON.parse(handleDecisionClassify({ decision })) as Verdict;

describe('decision_classify MCP tool', () => {
  it('returns the classifier verdict as JSON for a principle-settleable decision', () => {
    const out = classify('rename the variable');
    expect(out.verdict).toBe('DECIDE');
    expect(out.source).toBe('heuristic');
    expect(Array.isArray(out.matched)).toBe(true);
  });

  it('classifies an irreversible/outward decision as ESCALATE', () => {
    expect(classify('npm publish the release').verdict).toBe('ESCALATE');
  });

  it('DEFERs when no deterministic signal fires (agent decides, Inv 3)', () => {
    const out = classify('LRU or TTL for the cache?');
    expect(out.verdict).toBe('DEFER');
    expect(out.confidence).toBe(0);
  });

  it('schema rejects an empty decision', () => {
    expect(DecisionClassifySchema.safeParse({ decision: '' }).success).toBe(false);
  });
});
