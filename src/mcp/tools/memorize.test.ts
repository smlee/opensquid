/**
 * Unit tests for `handleMemorize` — Zod validation + engine delegation +
 * T-CTX-LOOP CTX.0 verify-probe gate.
 *
 * Mocks the EngineClient so we only assert the handler-level contract:
 *   - delegates to memoryCreate exactly once with mapped args
 *   - returns shape `{ id, authored_by, scope, created_at }`
 *   - scope defaults to 'user'
 *   - explicit `authored_by: 'agent'` propagates verbatim
 *   - CTX.0: verified+confirmed_quote required (Zod-rejects when absent)
 *   - CTX.0: confirmed_quote appended to persisted content as trailer
 */

import { describe, expect, it, vi } from 'vitest';

import type { EngineClient } from '../../engine/client.js';
import type { CreateMemoryResult } from '../../engine/types.js';

import { MemorizeSchema, handleMemorize } from './memorize.js';

function mkEngine(result: CreateMemoryResult): {
  client: EngineClient;
  spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn().mockResolvedValue(result);
  const client = { memoryCreate: spy } as unknown as EngineClient;
  return { client, spy };
}

const SAMPLE_RESULT: CreateMemoryResult = {
  id: 'mem-abc123',
  description: 'sample',
  created_at: '2026-05-24T00:00:00Z',
  scope: 'user',
};

/** Minimal verified args shape — used by every test that needs a parse to succeed. */
const VERIFIED = {
  description: 'd',
  content: 'c',
  verified: true as const,
  confirmed_quote: 'yes save it',
};

describe('handleMemorize', () => {
  it('returns id + authored_by + scope + created_at with user default', async () => {
    const { client, spy } = mkEngine(SAMPLE_RESULT);
    const out = await handleMemorize(MemorizeSchema.parse(VERIFIED), client);
    expect(out).toEqual({
      id: 'mem-abc123',
      authored_by: 'user',
      scope: 'user',
      created_at: '2026-05-24T00:00:00Z',
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const call = spy.mock.calls[0]?.[0] as { authored_by: string; scope: unknown };
    expect(call.authored_by).toBe('user');
    expect(call.scope).toBe('user');
  });

  it('rejects description > 280 chars via Zod', () => {
    const long = 'x'.repeat(281);
    const result = MemorizeSchema.safeParse({ ...VERIFIED, description: long });
    expect(result.success).toBe(false);
  });

  it('rejects empty content via Zod', () => {
    const result = MemorizeSchema.safeParse({ ...VERIFIED, content: '' });
    expect(result.success).toBe(false);
  });

  it('propagates explicit authored_by: "agent" verbatim (not marked immune)', async () => {
    const { client, spy } = mkEngine(SAMPLE_RESULT);
    const out = await handleMemorize(
      MemorizeSchema.parse({ ...VERIFIED, authored_by: 'agent' }),
      client,
    );
    expect(out.authored_by).toBe('agent');
    const call = spy.mock.calls[0]?.[0] as { authored_by: string };
    expect(call.authored_by).toBe('agent');
  });

  it('defaults scope to "user" when omitted', () => {
    const parsed = MemorizeSchema.parse(VERIFIED);
    expect(parsed.scope).toBe('user');
  });

  it('maps scope "project" to engine object shape', async () => {
    const { client, spy } = mkEngine(SAMPLE_RESULT);
    await handleMemorize(MemorizeSchema.parse({ ...VERIFIED, scope: 'project' }), client);
    const call = spy.mock.calls[0]?.[0] as { scope: unknown };
    expect(call.scope).toEqual({ project: '' });
  });

  // --- T-CTX-LOOP CTX.0: verify-probe gate ---

  it('CTX.0: rejects when `verified` field is absent (Zod)', () => {
    const result = MemorizeSchema.safeParse({
      description: 'd',
      content: 'c',
      confirmed_quote: 'yes',
    });
    expect(result.success).toBe(false);
  });

  it('CTX.0: rejects when `verified` is false (only literal `true` accepted)', () => {
    const result = MemorizeSchema.safeParse({
      description: 'd',
      content: 'c',
      verified: false,
      confirmed_quote: 'yes',
    });
    expect(result.success).toBe(false);
  });

  it('CTX.0: rejects when `confirmed_quote` is absent', () => {
    const result = MemorizeSchema.safeParse({
      description: 'd',
      content: 'c',
      verified: true,
    });
    expect(result.success).toBe(false);
  });

  it('CTX.0: rejects when `confirmed_quote` is empty string', () => {
    const result = MemorizeSchema.safeParse({ ...VERIFIED, confirmed_quote: '' });
    expect(result.success).toBe(false);
  });

  it('CTX.0: appends verification trailer carrying confirmed_quote into persisted content', async () => {
    const { client, spy } = mkEngine(SAMPLE_RESULT);
    await handleMemorize(
      MemorizeSchema.parse({
        ...VERIFIED,
        content: 'original body',
        confirmed_quote: 'yep save that exactly',
      }),
      client,
    );
    const call = spy.mock.calls[0]?.[0] as { content: string };
    expect(call.content).toContain('original body');
    expect(call.content).toContain('T-CTX-LOOP CTX.0 verified');
    expect(call.content).toContain('yep save that exactly');
  });

  it('CTX.0: trailer is appended (not prepended) so original content leads', async () => {
    const { client, spy } = mkEngine(SAMPLE_RESULT);
    await handleMemorize(MemorizeSchema.parse({ ...VERIFIED, content: 'leading body' }), client);
    const call = spy.mock.calls[0]?.[0] as { content: string };
    expect(call.content.startsWith('leading body')).toBe(true);
  });
});
