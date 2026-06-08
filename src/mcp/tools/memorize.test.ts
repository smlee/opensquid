/**
 * Unit tests for `handleMemorize` — Zod validation + CTX.0 verify-probe gate + the retire-Rust
 * write-path cutover (stores a `Lesson` via `RagBackend.storeLesson`, not the engine directly).
 *
 * Mocks a RagBackend so we assert the handler contract:
 *   - stores a Lesson exactly once (content-hash id, source 'memory')
 *   - returns shape `{ id, authored_by, scope, created_at }`; scope defaults to 'user'
 *   - `authored_by:'user'` ⇒ Lesson.author 'user' (eviction-immune); 'agent' ⇒ 'agent'
 *   - scope rides as a `scope:<x>` tag (recall is tag/content-based)
 *   - CTX.0: verified+confirmed_quote required (Zod); confirmed_quote appended as a content trailer
 */

import { describe, expect, it, vi } from 'vitest';

import type { Lesson, RagBackend } from '../../rag/types.js';

import { MemorizeSchema, handleMemorize } from './memorize.js';

function mkBackend(): { backend: RagBackend; spy: ReturnType<typeof vi.fn> } {
  const spy = vi.fn().mockResolvedValue(undefined);
  const backend: RagBackend = {
    init: () => Promise.resolve(),
    embed: () => Promise.resolve(null),
    recall: () => Promise.resolve([]),
    storeLesson: spy,
    deleteLesson: () => Promise.resolve({ deleted: false, forced: false }),
  };
  return { backend, spy };
}

/** Minimal verified args shape — used by every test that needs a parse to succeed. */
const VERIFIED = {
  description: 'd',
  content: 'c',
  verified: true as const,
  confirmed_quote: 'yes save it',
};

describe('handleMemorize', () => {
  it('stores a memory Lesson + returns id/authored_by/scope/created_at (user default)', async () => {
    const { backend, spy } = mkBackend();
    const out = await handleMemorize(MemorizeSchema.parse(VERIFIED), backend);
    expect(out.id).toMatch(/^mem-[0-9a-f]{16}$/);
    expect(out.authored_by).toBe('user');
    expect(out.scope).toBe('user');
    expect(typeof out.created_at).toBe('string');
    expect(spy).toHaveBeenCalledTimes(1);
    const lesson = spy.mock.calls[0]?.[0] as Lesson;
    expect(lesson.id).toBe(out.id);
    expect(lesson.author).toBe('user');
    expect(lesson.source).toBe('memory');
    expect(lesson.tags).toContain('scope:user');
  });

  it('id is the content-hash of the BODY (idempotent re-memorize, timestamp-independent)', async () => {
    // The verify-trailer embeds a wall-clock timestamp; the id must hash the
    // pre-trailer body so re-memorizing the same content+quote yields the SAME id
    // (the backend then upserts by id). Regression guard for the F0c-flagged bug
    // where the id hashed the timestamped trailer → a new id every call.
    const { backend: b1, spy: s1 } = mkBackend();
    const { backend: b2, spy: s2 } = mkBackend();
    const out1 = await handleMemorize(MemorizeSchema.parse(VERIFIED), b1);
    const out2 = await handleMemorize(MemorizeSchema.parse(VERIFIED), b2);
    expect(out1.id).toBe(out2.id);
    // ...and a DIFFERENT body yields a different id.
    const out3 = await handleMemorize(
      MemorizeSchema.parse({ ...VERIFIED, content: 'a different body' }),
      mkBackend().backend,
    );
    expect(out3.id).not.toBe(out1.id);
    expect(s1).toHaveBeenCalledTimes(1);
    expect(s2).toHaveBeenCalledTimes(1);
  });

  it('rejects description > 280 chars via Zod', () => {
    expect(MemorizeSchema.safeParse({ ...VERIFIED, description: 'x'.repeat(281) }).success).toBe(
      false,
    );
  });

  it('rejects empty content via Zod', () => {
    expect(MemorizeSchema.safeParse({ ...VERIFIED, content: '' }).success).toBe(false);
  });

  it('propagates authored_by "agent" → Lesson.author agent (not immune)', async () => {
    const { backend, spy } = mkBackend();
    const out = await handleMemorize(
      MemorizeSchema.parse({ ...VERIFIED, authored_by: 'agent' }),
      backend,
    );
    expect(out.authored_by).toBe('agent');
    expect((spy.mock.calls[0]?.[0] as Lesson).author).toBe('agent');
  });

  it('defaults scope to "user" when omitted', () => {
    expect(MemorizeSchema.parse(VERIFIED).scope).toBe('user');
  });

  it('maps scope "project" to a scope tag', async () => {
    const { backend, spy } = mkBackend();
    await handleMemorize(MemorizeSchema.parse({ ...VERIFIED, scope: 'project' }), backend);
    expect((spy.mock.calls[0]?.[0] as Lesson).tags).toContain('scope:project');
  });

  // --- T-CTX-LOOP CTX.0: verify-probe gate (schema-level, backend-agnostic) ---

  it('CTX.0: rejects when `verified` field is absent (Zod)', () => {
    expect(
      MemorizeSchema.safeParse({ description: 'd', content: 'c', confirmed_quote: 'y' }).success,
    ).toBe(false);
  });

  it('CTX.0: rejects when `verified` is false (only literal `true`)', () => {
    expect(
      MemorizeSchema.safeParse({
        description: 'd',
        content: 'c',
        verified: false,
        confirmed_quote: 'y',
      }).success,
    ).toBe(false);
  });

  it('CTX.0: rejects when `confirmed_quote` is absent', () => {
    expect(
      MemorizeSchema.safeParse({ description: 'd', content: 'c', verified: true }).success,
    ).toBe(false);
  });

  it('CTX.0: rejects when `confirmed_quote` is empty string', () => {
    expect(MemorizeSchema.safeParse({ ...VERIFIED, confirmed_quote: '' }).success).toBe(false);
  });

  it('CTX.0: appends the verification trailer (carrying confirmed_quote) into stored content', async () => {
    const { backend, spy } = mkBackend();
    await handleMemorize(
      MemorizeSchema.parse({
        ...VERIFIED,
        content: 'original body',
        confirmed_quote: 'yep save that exactly',
      }),
      backend,
    );
    const lesson = spy.mock.calls[0]?.[0] as Lesson;
    expect(lesson.content).toContain('original body');
    expect(lesson.content).toContain('T-CTX-LOOP CTX.0 verified');
    expect(lesson.content).toContain('yep save that exactly');
  });

  it('CTX.0: trailer is appended (not prepended) so original content leads', async () => {
    const { backend, spy } = mkBackend();
    await handleMemorize(MemorizeSchema.parse({ ...VERIFIED, content: 'leading body' }), backend);
    expect((spy.mock.calls[0]?.[0] as Lesson).content.startsWith('leading body')).toBe(true);
  });
});
