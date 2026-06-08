/**
 * Unit tests for `handleForget` — routes through `RagBackend.deleteLesson`; the backend owns the
 * user-authored immunity check (throws `UserAuthoredImmunityError`) and the not-found signal
 * (`{ deleted: false }` → `MemoryNotFoundError`); `force` passes through.
 */

import { describe, expect, it, vi } from 'vitest';

import { UserAuthoredImmunityError } from '../../rag/types.js';
import type { RagBackend } from '../../rag/types.js';

import { ForgetSchema, MemoryNotFoundError, handleForget } from './forget.js';

function mkBackend(deleteLesson: RagBackend['deleteLesson']): RagBackend {
  return {
    init: () => Promise.resolve(),
    embed: () => Promise.resolve(null),
    recall: () => Promise.resolve([]),
    storeLesson: () => Promise.resolve(),
    deleteLesson,
  };
}

describe('handleForget', () => {
  it('deletes an agent-authored memory with force=false', async () => {
    const spy = vi.fn().mockResolvedValue({ deleted: true, forced: false });
    const out = await handleForget(ForgetSchema.parse({ id: 'mem-1' }), mkBackend(spy));
    expect(out).toEqual({ deleted: true, id: 'mem-1', forced: false });
    expect(spy).toHaveBeenCalledWith('mem-1', { force: false });
  });

  it('propagates UserAuthoredImmunityError when the backend rejects an immune delete', async () => {
    const spy = vi.fn().mockRejectedValue(new UserAuthoredImmunityError('mem-1'));
    await expect(
      handleForget(ForgetSchema.parse({ id: 'mem-1' }), mkBackend(spy)),
    ).rejects.toBeInstanceOf(UserAuthoredImmunityError);
  });

  it('deletes a user-authored memory when force=true', async () => {
    const spy = vi.fn().mockResolvedValue({ deleted: true, forced: true });
    const out = await handleForget(
      ForgetSchema.parse({ id: 'mem-1', force: true }),
      mkBackend(spy),
    );
    expect(out).toEqual({ deleted: true, id: 'mem-1', forced: true });
    expect(spy).toHaveBeenCalledWith('mem-1', { force: true });
  });

  it('throws MemoryNotFoundError when the backend reports not-found', async () => {
    const spy = vi.fn().mockResolvedValue({ deleted: false, forced: false });
    await expect(
      handleForget(ForgetSchema.parse({ id: 'mem-x' }), mkBackend(spy)),
    ).rejects.toBeInstanceOf(MemoryNotFoundError);
  });

  it('Zod rejects empty id', () => {
    expect(ForgetSchema.safeParse({ id: '' }).success).toBe(false);
  });

  it('Zod defaults force to false', () => {
    expect(ForgetSchema.parse({ id: 'mem-1' }).force).toBe(false);
  });
});
