/**
 * Unit tests for the lesson primitives (`propose_lesson`, `promote_lesson`,
 * `recall_lesson`) using a stubbed EngineClient — no real engine spawn.
 *
 * E2E coverage (real engine + real wedge gate firing) lives in
 * `test/e2e/wedge_gate.test.ts` — that's the proof the moat fires. This
 * file covers the function-layer plumbing:
 *   - Zod argument validation (min(1), bounded limit, enum authored_by)
 *   - `propose_lesson` authored_by translation ('agent' → undefined)
 *   - `promote_lesson` gate-block surface ({status:'blocked', reasons})
 *   - `promote_lesson` non-gate RpcError pass-through (runtime error)
 *   - `promote_lesson` success path returns {status:'promoted', detail}
 *   - `recall_lesson` happy path + non-existent recall surfaces cleanly
 *
 * NO "promote_lesson succeeds against unsatisfied gate" test — see
 * `lessons.ts` header for the no-promote-success rationale. The gate is
 * intentionally unsatisfiable in unit-test timescales; satisfying it is
 * the moat working as designed.
 */

import { describe, expect, it } from 'vitest';

import { ENGINE_ERROR, EngineClient, RpcError } from '../engine/client.js';
import type {
  LessonCreateParams,
  LessonCreateResult,
  LessonPromoteResult,
  LessonRecallResult,
} from '../engine/types.js';
import type { Event } from '../runtime/types.js';

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

/**
 * Build an EngineClient stub where each `lesson*` method is replaced with a
 * caller-supplied implementation. Keeps the test focused on the function-
 * layer plumbing — no real socket, no real daemon.
 *
 * We construct a real EngineClient instance then monkey-patch the methods
 * so `instanceof RpcError` checks inside `lessons.ts` still work without
 * needing a parallel class hierarchy.
 */
interface StubMethods {
  lessonCreate?: (p: LessonCreateParams) => Promise<LessonCreateResult>;
  lessonPromote?: (p: { id: string }) => Promise<LessonPromoteResult>;
  lessonRecall?: (p: { query: string; limit?: number }) => Promise<LessonRecallResult>;
}

function stubClient(methods: StubMethods): EngineClient {
  const c = new EngineClient();
  if (methods.lessonCreate) c.lessonCreate = methods.lessonCreate;
  if (methods.lessonPromote) c.lessonPromote = methods.lessonPromote;
  if (methods.lessonRecall) c.lessonRecall = methods.lessonRecall;
  return c;
}

function freshRegistry(client: EngineClient): FunctionRegistry {
  const r = new FunctionRegistry();
  registerLessonFunctions(r, client);
  return r;
}

// ---------------------------------------------------------------------------
// propose_lesson
// ---------------------------------------------------------------------------

describe('propose_lesson', () => {
  it('passes args through and returns {id, status} on success', async () => {
    let received: LessonCreateParams | undefined;
    const client = stubClient({
      lessonCreate: (p) => {
        received = p;
        return Promise.resolve({
          id: 'les-abc123',
          status: 'pending',
          authored_by: 'agent',
          created_at: '2026-05-22T00:00:00Z',
          updated: false,
        });
      },
    });
    const r = freshRegistry(client);

    const result = await r.call(
      'propose_lesson',
      {
        description: 'a candidate lesson',
        body: 'body content',
        evidence: ['mem-001'],
      },
      createTestCtx(),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ id: 'les-abc123', status: 'pending' });
    }
    expect(received?.description).toBe('a candidate lesson');
    expect(received?.body).toBe('body content');
    expect(received?.evidence).toEqual(['mem-001']);
  });

  it("translates authored_by 'user' verbatim (eviction-immune path)", async () => {
    let received: LessonCreateParams | undefined;
    const client = stubClient({
      lessonCreate: (p) => {
        received = p;
        return Promise.resolve({
          id: 'les-u',
          status: 'pending',
          authored_by: 'user',
          created_at: '2026-05-22T00:00:00Z',
          updated: false,
        });
      },
    });
    const r = freshRegistry(client);

    await r.call(
      'propose_lesson',
      { description: 'd', body: 'b', authored_by: 'user' },
      createTestCtx(),
    );
    expect(received?.authored_by).toBe('user');
  });

  it("translates authored_by 'agent' to undefined (engine Llm default)", async () => {
    let received: LessonCreateParams | undefined;
    const client = stubClient({
      lessonCreate: (p) => {
        received = p;
        return Promise.resolve({
          id: 'les-a',
          status: 'pending',
          authored_by: 'agent',
          created_at: '2026-05-22T00:00:00Z',
          updated: false,
        });
      },
    });
    const r = freshRegistry(client);

    await r.call(
      'propose_lesson',
      { description: 'd', body: 'b', authored_by: 'agent' },
      createTestCtx(),
    );
    // T.1.G: 'agent' silently maps to engine's Llm default. We translate to
    // undefined so the engine applies its default rather than rejecting an
    // unknown enum value.
    expect(received?.authored_by).toBeUndefined();
  });

  it('rejects empty description (Zod min(1))', async () => {
    const client = stubClient({});
    const r = freshRegistry(client);
    const result = await r.call('propose_lesson', { description: '', body: 'b' }, createTestCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('arg_invalid');
  });

  it('surfaces engine errors as kind:runtime', async () => {
    const client = stubClient({
      lessonCreate: () => Promise.reject(new Error('engine boom')),
    });
    const r = freshRegistry(client);
    const result = await r.call('propose_lesson', { description: 'd', body: 'b' }, createTestCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('runtime');
      expect(result.error.message).toContain('propose_lesson');
      expect(result.error.message).toContain('engine boom');
    }
  });
});

// ---------------------------------------------------------------------------
// promote_lesson — the wedge gate surface.
// ---------------------------------------------------------------------------

describe('promote_lesson — gate block surface (THE MOAT)', () => {
  it('returns {status:"blocked", reasons} on RpcError -32000 (gate fired)', async () => {
    // Engine error wire shape per T.1.E + T.1.F: code = -32000
    // (PROMOTION_BLOCKED), data.reasons = kebab-case BlockReason strings.
    const reasons = [
      'missing-external-signal-sources',
      'missing-causal-narrative',
      'insufficient-applied-count: observed=0 < required=3',
      'time-floor: age=5s < required=86400s',
    ];
    const client = stubClient({
      lessonPromote: () =>
        Promise.reject(
          new RpcError('promotion blocked', ENGINE_ERROR.PROMOTION_BLOCKED, { reasons }),
        ),
    });
    const r = freshRegistry(client);

    const result = await r.call('promote_lesson', { id: 'les-blocked' }, createTestCtx());
    expect(result.ok).toBe(true); // gate firing is NOT a runtime error
    if (result.ok) {
      expect(result.value).toEqual({ status: 'blocked', reasons });
    }
  });

  it('handles missing data.reasons gracefully (defensive [])', async () => {
    const client = stubClient({
      lessonPromote: () =>
        Promise.reject(new RpcError('promotion blocked', ENGINE_ERROR.PROMOTION_BLOCKED)),
    });
    const r = freshRegistry(client);

    const result = await r.call('promote_lesson', { id: 'les-x' }, createTestCtx());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ status: 'blocked', reasons: [] });
    }
  });

  it('passes through non-gate RpcError as kind:runtime', async () => {
    // -32002 NOT_FOUND is a different engine error — must NOT be coerced
    // into a {status:'blocked'} response. Only -32000 means gate-block.
    const client = stubClient({
      lessonPromote: () =>
        Promise.reject(
          new RpcError('lesson not found', ENGINE_ERROR.NOT_FOUND, { id: 'les-missing' }),
        ),
    });
    const r = freshRegistry(client);

    const result = await r.call('promote_lesson', { id: 'les-missing' }, createTestCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('runtime');
      expect(result.error.message).toContain('promote_lesson');
    }
  });

  it('returns {status:"promoted", detail} on successful promotion', async () => {
    // This is the path that fires in PRODUCTION over real session usage
    // (after the 24h floor + applied_count + external_signal_sources are
    // satisfied). We test the function-layer surface here; we do NOT test
    // a real engine satisfying the gate — see lessons.ts header for the
    // no-promote-success rationale.
    const detail: LessonPromoteResult = {
      ok: true,
      id: 'les-ok',
      gate: 'passed',
      status: 'promoted',
      from: 'pending',
    };
    const client = stubClient({
      lessonPromote: () => Promise.resolve(detail),
    });
    const r = freshRegistry(client);

    const result = await r.call('promote_lesson', { id: 'les-ok' }, createTestCtx());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ status: 'promoted', detail });
    }
  });

  it('rejects empty id (Zod min(1))', async () => {
    const client = stubClient({});
    const r = freshRegistry(client);
    const result = await r.call('promote_lesson', { id: '' }, createTestCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('arg_invalid');
  });

  it('surfaces non-RpcError throws as kind:runtime', async () => {
    const client = stubClient({
      lessonPromote: () => Promise.reject(new Error('socket exploded')),
    });
    const r = freshRegistry(client);
    const result = await r.call('promote_lesson', { id: 'les-x' }, createTestCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('runtime');
      expect(result.error.message).toContain('socket exploded');
    }
  });
});

// ---------------------------------------------------------------------------
// recall_lesson
// ---------------------------------------------------------------------------

describe('recall_lesson', () => {
  it('returns the engine recall result on success', async () => {
    const recall: LessonRecallResult = {
      query: 'git rebase',
      returned: 1,
      results: [
        {
          kind: 'lesson',
          id: 'les-1',
          description: 'never rebase shared branches',
          status: 'promoted',
          body_preview: '...',
          similarity: 0.82,
          applied_count: 12,
        },
      ],
    };
    const client = stubClient({
      lessonRecall: () => Promise.resolve(recall),
    });
    const r = freshRegistry(client);

    const result = await r.call(
      'recall_lesson',
      { query: 'git rebase', limit: 5 },
      createTestCtx(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(recall);
  });

  it('returns empty results shape on no-match', async () => {
    const client = stubClient({
      lessonRecall: () => Promise.resolve({ query: 'nothing here', returned: 0, results: [] }),
    });
    const r = freshRegistry(client);
    const result = await r.call('recall_lesson', { query: 'nothing here' }, createTestCtx());
    expect(result.ok).toBe(true);
    if (result.ok) {
      const v = result.value as LessonRecallResult;
      expect(v.returned).toBe(0);
      expect(v.results).toEqual([]);
    }
  });

  it('rejects empty query (Zod min(1))', async () => {
    const client = stubClient({});
    const r = freshRegistry(client);
    const result = await r.call('recall_lesson', { query: '' }, createTestCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('arg_invalid');
  });

  it('rejects limit > 50 (Zod bound)', async () => {
    const client = stubClient({});
    const r = freshRegistry(client);
    const result = await r.call('recall_lesson', { query: 'q', limit: 51 }, createTestCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('arg_invalid');
  });

  it('surfaces engine errors as kind:runtime', async () => {
    const client = stubClient({
      lessonRecall: () => Promise.reject(new Error('storage list failed')),
    });
    const r = freshRegistry(client);
    const result = await r.call('recall_lesson', { query: 'q' }, createTestCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('runtime');
      expect(result.error.message).toContain('recall_lesson');
    }
  });
});

// ---------------------------------------------------------------------------
// Registration shape — registry must see exactly 3 names with explicit
// durability flags (no registry warnings).
// ---------------------------------------------------------------------------

describe('registerLessonFunctions — registry shape', () => {
  it('registers exactly propose_lesson, promote_lesson, recall_lesson', () => {
    const client = stubClient({});
    const r = freshRegistry(client);
    expect(r.has('propose_lesson')).toBe(true);
    expect(r.has('promote_lesson')).toBe(true);
    expect(r.has('recall_lesson')).toBe(true);
  });

  it('declares durability flags explicitly (no default-false warning)', () => {
    const client = stubClient({});
    const r = freshRegistry(client);
    for (const name of ['propose_lesson', 'promote_lesson', 'recall_lesson']) {
      const d = r.durability(name);
      expect(d).toBeDefined();
      expect(d?.durable).toBe(true);
    }
    // Only recall is memoizable — writes (propose / promote) must not be.
    expect(r.durability('propose_lesson')?.memoizable).toBe(false);
    expect(r.durability('promote_lesson')?.memoizable).toBe(false);
    expect(r.durability('recall_lesson')?.memoizable).toBe(true);
  });
});
