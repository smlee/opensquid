/**
 * Unit tests for `handleMemorize` — Zod validation + engine delegation.
 *
 * Mocks the EngineClient so we only assert the handler-level contract:
 *   - delegates to memoryCreate exactly once with mapped args
 *   - returns shape `{ id, authored_by, scope, created_at }`
 *   - scope defaults to 'user'
 *   - explicit `authored_by: 'agent'` propagates verbatim
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

describe('handleMemorize', () => {
  it('returns id + authored_by + scope + created_at with user default', async () => {
    const { client, spy } = mkEngine(SAMPLE_RESULT);
    const out = await handleMemorize(
      MemorizeSchema.parse({ description: 'd', content: 'c' }),
      client,
    );
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
    const result = MemorizeSchema.safeParse({ description: long, content: 'c' });
    expect(result.success).toBe(false);
  });

  it('rejects empty content via Zod', () => {
    const result = MemorizeSchema.safeParse({ description: 'd', content: '' });
    expect(result.success).toBe(false);
  });

  it('propagates explicit authored_by: "agent" verbatim (not marked immune)', async () => {
    const { client, spy } = mkEngine(SAMPLE_RESULT);
    const out = await handleMemorize(
      MemorizeSchema.parse({ description: 'd', content: 'c', authored_by: 'agent' }),
      client,
    );
    expect(out.authored_by).toBe('agent');
    const call = spy.mock.calls[0]?.[0] as { authored_by: string };
    expect(call.authored_by).toBe('agent');
  });

  it('defaults scope to "user" when omitted', () => {
    const parsed = MemorizeSchema.parse({ description: 'd', content: 'c' });
    expect(parsed.scope).toBe('user');
  });

  it('maps scope "project" to engine object shape', async () => {
    const { client, spy } = mkEngine(SAMPLE_RESULT);
    await handleMemorize(
      MemorizeSchema.parse({ description: 'd', content: 'c', scope: 'project' }),
      client,
    );
    const call = spy.mock.calls[0]?.[0] as { scope: unknown };
    expect(call.scope).toEqual({ project: '' });
  });
});
