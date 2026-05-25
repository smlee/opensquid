/**
 * Unit tests for `handleForget` — existence guard + user-authored
 * immunity guard + force passthrough.
 *
 * The immunity guard relies on the engine's `USER_MEMORY_IMMUNE` (-32003)
 * error code, which the handler maps to a typed `UserAuthoredImmunityError`
 * so MCP callers can branch on the immunity case without parsing JSON-RPC
 * error codes themselves.
 */

import { describe, expect, it, vi } from 'vitest';

import { ENGINE_ERROR, RpcError } from '../../engine/client.js';
import type { EngineClient } from '../../engine/client.js';
import type { GetMemoryResult, MemoryDeleteResult } from '../../engine/types.js';

import { ForgetSchema, UserAuthoredImmunityError, handleForget } from './forget.js';

const EXISTING_MEMORY: GetMemoryResult = {
  id: 'mem-1',
  description: 'a memory',
  content: 'body',
  created_at: '2026-05-24T00:00:00Z',
  scope: 'user',
};

function mkEngine(opts: {
  getResult?: GetMemoryResult;
  getError?: Error;
  deleteResult?: MemoryDeleteResult;
  deleteError?: Error;
}): {
  client: EngineClient;
  getSpy: ReturnType<typeof vi.fn>;
  deleteSpy: ReturnType<typeof vi.fn>;
} {
  const getSpy = vi.fn();
  if (opts.getError) getSpy.mockRejectedValue(opts.getError);
  else getSpy.mockResolvedValue(opts.getResult ?? EXISTING_MEMORY);

  const deleteSpy = vi.fn();
  if (opts.deleteError) deleteSpy.mockRejectedValue(opts.deleteError);
  else deleteSpy.mockResolvedValue(opts.deleteResult ?? { ok: true, id: 'mem-1', forced: false });

  const client = { memoryGet: getSpy, memoryDelete: deleteSpy } as unknown as EngineClient;
  return { client, getSpy, deleteSpy };
}

describe('handleForget', () => {
  it('deletes an agent-authored memory with force=false', async () => {
    const { client, deleteSpy } = mkEngine({});
    const out = await handleForget(ForgetSchema.parse({ id: 'mem-1' }), client);
    expect(out).toEqual({ deleted: true, id: 'mem-1', forced: false });
    expect(deleteSpy).toHaveBeenCalledWith({ id: 'mem-1', force: false });
  });

  it('throws UserAuthoredImmunityError when engine returns -32003 without force', async () => {
    const { client, deleteSpy } = mkEngine({
      deleteError: new RpcError(
        'user-cited memory is eviction-immune',
        ENGINE_ERROR.USER_MEMORY_IMMUNE,
        {
          memory_id: 'mem-1',
          cited_by: 2,
        },
      ),
    });
    await expect(handleForget(ForgetSchema.parse({ id: 'mem-1' }), client)).rejects.toBeInstanceOf(
      UserAuthoredImmunityError,
    );
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    // memoryDelete WAS called — engine is the immunity authority. Handler
    // maps the engine's typed error to a domain error for MCP callers.
  });

  it('deletes a user-authored memory when force=true', async () => {
    const { client, deleteSpy } = mkEngine({
      deleteResult: { ok: true, id: 'mem-1', forced: true },
    });
    const out = await handleForget(ForgetSchema.parse({ id: 'mem-1', force: true }), client);
    expect(out).toEqual({ deleted: true, id: 'mem-1', forced: true });
    expect(deleteSpy).toHaveBeenCalledWith({ id: 'mem-1', force: true });
  });

  it('propagates NOT_FOUND from memoryGet as RpcError (-32002)', async () => {
    const notFound = new RpcError('memory not found', ENGINE_ERROR.NOT_FOUND, { id: 'mem-x' });
    const { client, deleteSpy } = mkEngine({ getError: notFound });
    await expect(handleForget(ForgetSchema.parse({ id: 'mem-x' }), client)).rejects.toBe(notFound);
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it('re-throws non-immunity RpcErrors from memoryDelete unchanged', async () => {
    const internal = new RpcError('disk full', ENGINE_ERROR.INTERNAL);
    const { client } = mkEngine({ deleteError: internal });
    await expect(handleForget(ForgetSchema.parse({ id: 'mem-1' }), client)).rejects.toBe(internal);
  });

  it('Zod rejects empty id', () => {
    const r = ForgetSchema.safeParse({ id: '' });
    expect(r.success).toBe(false);
  });

  it('Zod defaults force to false', () => {
    const r = ForgetSchema.parse({ id: 'mem-1' });
    expect(r.force).toBe(false);
  });
});
