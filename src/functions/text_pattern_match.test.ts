/**
 * Tests for `text_pattern_match` primitive (G.5).
 *
 * Coverage per spec test fixtures (lines 1073–1078):
 *   - Single pattern match at offset 0
 *   - No-match returns empty
 *   - Malformed regex → arg_invalid Err
 *   - Dot-notation field extraction
 *   - Missing field → empty (graceful, no throw)
 *   - Case-insensitive by default; opt-in case_sensitive
 *   - Multiple patterns aggregate matches
 *   - Empty patterns array → arg_invalid (Zod min(1))
 */

import { describe, expect, it } from 'vitest';

import type { Event } from '../runtime/types.js';

import { type EvalCtx, FunctionRegistry } from './registry.js';
import { TextPatternMatch } from './text_pattern_match.js';

function freshRegistry(): FunctionRegistry {
  const reg = new FunctionRegistry();
  reg.register(TextPatternMatch);
  return reg;
}

function ctxWith(event: Event): EvalCtx {
  return {
    event,
    bindings: new Map<string, unknown>(),
    sessionId: 'test-session',
    packId: 'test-pack',
  };
}

describe('text_pattern_match', () => {
  it('matches a single phrase at offset 0 in a Stop event', async () => {
    const reg = freshRegistry();
    const ctx = ctxWith({ kind: 'stop', assistantText: 'the plan is to X' });

    const result = await reg.call(
      'text_pattern_match',
      { text_field: 'assistantText', patterns: ['\\bthe plan is\\b'] },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      const v = result.value as {
        matched: string[];
        phrases: { phrase: string; offset: number }[];
      };
      expect(v.matched).toEqual(['the plan is']);
      expect(v.phrases).toEqual([{ phrase: 'the plan is', offset: 0 }]);
    }
  });

  it('returns empty arrays when no pattern matches', async () => {
    const reg = freshRegistry();
    const ctx = ctxWith({ kind: 'stop', assistantText: 'something else entirely' });

    const result = await reg.call(
      'text_pattern_match',
      { text_field: 'assistantText', patterns: ['\\bper memory\\b'] },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ matched: [], phrases: [] });
    }
  });

  it('returns arg_invalid Err on a malformed regex', async () => {
    const reg = freshRegistry();
    const ctx = ctxWith({ kind: 'stop', assistantText: 'hi' });

    const result = await reg.call(
      'text_pattern_match',
      { text_field: 'assistantText', patterns: ['[unclosed'] },
      ctx,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('arg_invalid');
  });

  it('traverses dot notation to extract nested text', async () => {
    const reg = freshRegistry();
    // Use a webhook-shaped payload to exercise nested extraction.
    const ctx = ctxWith({
      kind: 'webhook',
      subscriptionId: 's',
      method: 'POST',
      headers: {},
      body: { text: 'deferred again' },
      receivedAt: '2026-05-24T00:00:00Z',
    });

    const result = await reg.call(
      'text_pattern_match',
      { text_field: 'body.text', patterns: ['\\bdeferred\\b'] },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      const v = result.value as { matched: string[] };
      expect(v.matched).toEqual(['deferred']);
    }
  });

  it('returns empty when the text_field does not resolve to a string', async () => {
    const reg = freshRegistry();
    const ctx = ctxWith({ kind: 'stop', assistantText: 'hello' });

    const result = await reg.call(
      'text_pattern_match',
      { text_field: 'nonexistent.path', patterns: ['anything'] },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ matched: [], phrases: [] });
    }
  });

  it('is case-insensitive by default; case_sensitive=true narrows matches', async () => {
    const reg = freshRegistry();
    const ctx = ctxWith({ kind: 'stop', assistantText: 'PER MEMORY this should match by default' });

    const insensitive = await reg.call(
      'text_pattern_match',
      { text_field: 'assistantText', patterns: ['\\bper memory\\b'] },
      ctx,
    );
    expect(insensitive.ok).toBe(true);
    if (insensitive.ok) {
      expect((insensitive.value as { matched: string[] }).matched).toEqual(['PER MEMORY']);
    }

    const sensitive = await reg.call(
      'text_pattern_match',
      {
        text_field: 'assistantText',
        patterns: ['\\bper memory\\b'],
        case_sensitive: true,
      },
      ctx,
    );
    expect(sensitive.ok).toBe(true);
    if (sensitive.ok) {
      expect((sensitive.value as { matched: string[] }).matched).toEqual([]);
    }
  });

  it('aggregates matches across multiple patterns', async () => {
    const reg = freshRegistry();
    const ctx = ctxWith({
      kind: 'stop',
      assistantText: 'per memory the plan is deferred',
    });

    const result = await reg.call(
      'text_pattern_match',
      {
        text_field: 'assistantText',
        patterns: ['\\bper memory\\b', '\\bthe plan is\\b', '\\bdeferred\\b'],
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      const v = result.value as { matched: string[] };
      expect(v.matched.sort()).toEqual(['deferred', 'per memory', 'the plan is'].sort());
    }
  });

  it('rejects an empty patterns array via Zod min(1)', async () => {
    const reg = freshRegistry();
    const ctx = ctxWith({ kind: 'stop', assistantText: 'x' });

    const result = await reg.call(
      'text_pattern_match',
      { text_field: 'assistantText', patterns: [] },
      ctx,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('arg_invalid');
  });
});
