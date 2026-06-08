/**
 * Unit tests for the lesson primitives (`propose_lesson`, `promote_lesson`,
 * `recall_lesson`, `capture_feedback`, `record_applied`) using a stubbed
 * WedgeLessonStore — no real DB (retire-Rust RES-3c: the lesson surface is
 * engine-free). E2E coverage (real store + real wedge gate firing) lives in
 * `src/rag/wedge/store.test.ts`. This file covers the function-layer plumbing:
 *   - Zod argument validation (min(1), bounded limit, enum authored_by/polarity)
 *   - `propose_lesson` authored_by translation ('agent' → omitted) + evidence → evidenceRefs
 *   - `promote_lesson` gate-block surface ({status:'blocked', reasons}) via PromotionBlockedError
 *   - `promote_lesson` non-block error pass-through (runtime error)
 *   - `promote_lesson` success path returns {status:'promoted', detail}
 *   - `recall_lesson` happy path + no-match
 *   - `capture_feedback` / `record_applied` happy paths + arg validation
 */

import { describe, expect, it } from 'vitest';

import type { Event } from '../runtime/types.js';
import {
  PromotionBlockedError,
  type CreateLessonInput,
  type WedgeLessonStore,
  type WedgeRecallHit,
} from '../rag/wedge/store.js';

import { registerLessonFunctions } from './lessons.js';
import { type EvalCtx, FunctionRegistry } from './registry.js';

// ---------------------------------------------------------------------------
// Test helpers.
// ---------------------------------------------------------------------------

function createTestCtx(): EvalCtx {
  const event: Event = { kind: 'stop', assistantText: '' };
  return {
    event,
    bindings: new Map<string, unknown>(),
    sessionId: `session-${Math.random().toString(36).slice(2, 10)}`,
    packId: 'test-pack',
  };
}

interface StubMethods {
  createLesson?: (
    i: CreateLessonInput,
  ) => Promise<{ id: string; status: 'pending'; createdAt: string }>;
  promoteLesson?: (id: string) => Promise<{ id: string; status: 'promoted' }>;
  recallLesson?: (
    query: string,
    limit?: number,
  ) => Promise<{ query: string; returned: number; results: WedgeRecallHit[] }>;
  captureFeedback?: (id: string, polarity: 'up' | 'down', signalId: string) => Promise<void>;
  recordApplied?: (id: string, sessionId?: string) => Promise<void>;
}

/** A WedgeLessonStore stub — each method defaults to a benign no-op/empty result. */
function stubStore(methods: StubMethods): WedgeLessonStore {
  return {
    init: () => Promise.resolve(),
    createLesson:
      methods.createLesson ??
      (() =>
        Promise.resolve({ id: 'les-x', status: 'pending', createdAt: '2026-05-22T00:00:00Z' })),
    promoteLesson: methods.promoteLesson ?? ((id) => Promise.resolve({ id, status: 'promoted' })),
    recallLesson:
      methods.recallLesson ?? ((query) => Promise.resolve({ query, returned: 0, results: [] })),
    captureFeedback: methods.captureFeedback ?? (() => Promise.resolve()),
    recordApplied: methods.recordApplied ?? (() => Promise.resolve()),
  };
}

function freshRegistry(store: WedgeLessonStore): FunctionRegistry {
  const r = new FunctionRegistry();
  registerLessonFunctions(r, store);
  return r;
}

// ---------------------------------------------------------------------------
// propose_lesson
// ---------------------------------------------------------------------------

describe('propose_lesson', () => {
  it('passes args through (evidence → evidenceRefs) and returns {id, status}', async () => {
    let received: CreateLessonInput | undefined;
    const store = stubStore({
      createLesson: (i) => {
        received = i;
        return Promise.resolve({
          id: 'les-abc123',
          status: 'pending',
          createdAt: '2026-05-22T00:00:00Z',
        });
      },
    });
    const r = freshRegistry(store);

    const result = await r.call(
      'propose_lesson',
      { description: 'a candidate lesson', body: 'body content', evidence: ['mem-001'] },
      createTestCtx(),
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ id: 'les-abc123', status: 'pending' });
    expect(received?.description).toBe('a candidate lesson');
    expect(received?.body).toBe('body content');
    expect(received?.evidenceRefs).toEqual(['mem-001']);
  });

  it("translates authored_by 'user' verbatim (eviction-immune path)", async () => {
    let received: CreateLessonInput | undefined;
    const store = stubStore({
      createLesson: (i) => {
        received = i;
        return Promise.resolve({
          id: 'les-u',
          status: 'pending',
          createdAt: '2026-05-22T00:00:00Z',
        });
      },
    });
    const r = freshRegistry(store);
    await r.call(
      'propose_lesson',
      { description: 'd', body: 'b', authored_by: 'user' },
      createTestCtx(),
    );
    expect(received?.authoredBy).toBe('user');
  });

  it("translates authored_by 'agent' to omitted (store default)", async () => {
    let received: CreateLessonInput | undefined;
    const store = stubStore({
      createLesson: (i) => {
        received = i;
        return Promise.resolve({
          id: 'les-a',
          status: 'pending',
          createdAt: '2026-05-22T00:00:00Z',
        });
      },
    });
    const r = freshRegistry(store);
    await r.call(
      'propose_lesson',
      { description: 'd', body: 'b', authored_by: 'agent' },
      createTestCtx(),
    );
    expect(received?.authoredBy).toBeUndefined();
  });

  it('rejects empty description (Zod min(1))', async () => {
    const r = freshRegistry(stubStore({}));
    const result = await r.call('propose_lesson', { description: '', body: 'b' }, createTestCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('arg_invalid');
  });

  it('surfaces store errors as kind:runtime', async () => {
    const r = freshRegistry(
      stubStore({ createLesson: () => Promise.reject(new Error('store boom')) }),
    );
    const result = await r.call('propose_lesson', { description: 'd', body: 'b' }, createTestCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('runtime');
      expect(result.error.message).toContain('propose_lesson');
      expect(result.error.message).toContain('store boom');
    }
  });
});

// ---------------------------------------------------------------------------
// promote_lesson — the wedge gate surface.
// ---------------------------------------------------------------------------

describe('promote_lesson — gate block surface (THE MOAT)', () => {
  it('returns {status:"blocked", reasons} on PromotionBlockedError (gate fired)', async () => {
    const reasons = [
      'missing-external-signal-sources',
      'missing-causal-narrative',
      'insufficient-applied-count: observed=0 < required=3',
      'time-floor: age=5s < required=86400s',
    ];
    const r = freshRegistry(
      stubStore({ promoteLesson: (id) => Promise.reject(new PromotionBlockedError(id, reasons)) }),
    );
    const result = await r.call('promote_lesson', { id: 'les-blocked' }, createTestCtx());
    expect(result.ok).toBe(true); // gate firing is NOT a runtime error
    if (result.ok) expect(result.value).toEqual({ status: 'blocked', reasons });
  });

  it('passes through a non-block error as kind:runtime', async () => {
    const r = freshRegistry(
      stubStore({ promoteLesson: () => Promise.reject(new Error('lesson not found')) }),
    );
    const result = await r.call('promote_lesson', { id: 'les-missing' }, createTestCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('runtime');
      expect(result.error.message).toContain('promote_lesson');
    }
  });

  it('returns {status:"promoted", detail} on successful promotion', async () => {
    const detail = { id: 'les-ok', status: 'promoted' as const };
    const r = freshRegistry(stubStore({ promoteLesson: () => Promise.resolve(detail) }));
    const result = await r.call('promote_lesson', { id: 'les-ok' }, createTestCtx());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ status: 'promoted', detail });
  });

  it('rejects empty id (Zod min(1))', async () => {
    const r = freshRegistry(stubStore({}));
    const result = await r.call('promote_lesson', { id: '' }, createTestCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('arg_invalid');
  });
});

// ---------------------------------------------------------------------------
// recall_lesson
// ---------------------------------------------------------------------------

describe('recall_lesson', () => {
  it('returns the store recall result on success', async () => {
    const recall = {
      query: 'git rebase',
      returned: 1,
      results: [
        {
          kind: 'lesson' as const,
          id: 'les-1',
          description: 'never rebase shared branches',
          status: 'promoted' as const,
          body_preview: '...',
          similarity: 0.82,
          applied_count: 12,
        },
      ],
    };
    const r = freshRegistry(stubStore({ recallLesson: () => Promise.resolve(recall) }));
    const result = await r.call(
      'recall_lesson',
      { query: 'git rebase', limit: 5 },
      createTestCtx(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(recall);
  });

  it('rejects empty query (Zod min(1))', async () => {
    const r = freshRegistry(stubStore({}));
    const result = await r.call('recall_lesson', { query: '' }, createTestCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('arg_invalid');
  });

  it('rejects limit > 50 (Zod bound)', async () => {
    const r = freshRegistry(stubStore({}));
    const result = await r.call('recall_lesson', { query: 'q', limit: 51 }, createTestCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('arg_invalid');
  });

  it('surfaces store errors as kind:runtime', async () => {
    const r = freshRegistry(
      stubStore({ recallLesson: () => Promise.reject(new Error('fts failed')) }),
    );
    const result = await r.call('recall_lesson', { query: 'q' }, createTestCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('runtime');
      expect(result.error.message).toContain('recall_lesson');
    }
  });
});

// ---------------------------------------------------------------------------
// capture_feedback + record_applied — the in-process promote-satisfiability surfaces.
// ---------------------------------------------------------------------------

describe('capture_feedback + record_applied', () => {
  it('capture_feedback forwards (id, polarity, signal_id) → {id}', async () => {
    const calls: [string, string, string][] = [];
    const r = freshRegistry(
      stubStore({
        captureFeedback: (id, polarity, signalId) => {
          calls.push([id, polarity, signalId]);
          return Promise.resolve();
        },
      }),
    );
    const result = await r.call(
      'capture_feedback',
      { id: 'les-1', polarity: 'up', signal_id: 'user_thumbs_up' },
      createTestCtx(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ id: 'les-1' });
    expect(calls).toEqual([['les-1', 'up', 'user_thumbs_up']]);
  });

  it('capture_feedback rejects a bad polarity (Zod enum)', async () => {
    const r = freshRegistry(stubStore({}));
    const result = await r.call(
      'capture_feedback',
      { id: 'les-1', polarity: 'sideways', signal_id: 's' },
      createTestCtx(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('arg_invalid');
  });

  it('record_applied forwards (id, session_id) → {id}', async () => {
    const calls: [string, string | undefined][] = [];
    const r = freshRegistry(
      stubStore({
        recordApplied: (id, sessionId) => {
          calls.push([id, sessionId]);
          return Promise.resolve();
        },
      }),
    );
    const result = await r.call(
      'record_applied',
      { id: 'les-1', session_id: 's1' },
      createTestCtx(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ id: 'les-1' });
    expect(calls).toEqual([['les-1', 's1']]);
  });
});

// ---------------------------------------------------------------------------
// Registration shape — exactly 5 names with explicit durability flags.
// ---------------------------------------------------------------------------

describe('registerLessonFunctions — registry shape', () => {
  it('registers propose/promote/recall/capture_feedback/record_applied', () => {
    const r = freshRegistry(stubStore({}));
    for (const name of [
      'propose_lesson',
      'promote_lesson',
      'recall_lesson',
      'capture_feedback',
      'record_applied',
    ]) {
      expect(r.has(name)).toBe(true);
    }
  });

  it('declares durability flags explicitly (only recall memoizable)', () => {
    const r = freshRegistry(stubStore({}));
    for (const name of [
      'propose_lesson',
      'promote_lesson',
      'recall_lesson',
      'capture_feedback',
      'record_applied',
    ]) {
      expect(r.durability(name)?.durable).toBe(true);
    }
    expect(r.durability('propose_lesson')?.memoizable).toBe(false);
    expect(r.durability('promote_lesson')?.memoizable).toBe(false);
    expect(r.durability('recall_lesson')?.memoizable).toBe(true);
    expect(r.durability('capture_feedback')?.memoizable).toBe(false);
    expect(r.durability('record_applied')?.memoizable).toBe(false);
  });
});
