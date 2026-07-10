/**
 * `forget` MCP tool — delete a memory by id with user-authored immunity.
 *
 * G.3 architectural exception (read-only invariant): destruction must remain user-controllable.
 * Post retire-Rust write-path cutover (T-RETIRE-RUST-CUTOVER) this routes through the configured
 * `RagBackend.deleteLesson` (like `recall`/`memorize`) — the Rust engine is removed, so every
 * user hits the configured libSQL backend through the same seam.
 *
 * The user-authored eviction-immunity invariant (`feedback_user_authored_lessons_immune`) is
 * enforced by the backend: `deleteLesson` throws `UserAuthoredImmunityError` for a `user`-authored
 * lesson unless `force` is set (the libSQL backend checks the row's author). A not-found id returns
 * `{ deleted: false }`, which this handler maps
 * to a typed `MemoryNotFoundError` (mirrors the old memoryGet existence pre-check). Explicit user
 * deletion is allowed (with force); automatic deletion is never wired here (the no-auto-delete
 * invariant).
 *
 * Imports from: zod, ../../rag/types.js.
 * Imported by: mcp/server.ts (handler map).
 */

import { z } from 'zod';

import type { RagBackend } from '../../rag/types.js';

// Re-exported so existing importers (tests, callers) keep a single source for the typed error.
export { UserAuthoredImmunityError } from '../../rag/types.js';

export const ForgetSchema = z.object({
  id: z.string().min(1),
  force: z
    .boolean()
    .default(false)
    .describe('Required to delete a memory whose authored_by is "user"'),
});

export type ForgetArgs = z.infer<typeof ForgetSchema>;

export interface ForgetOutput {
  deleted: true;
  id: string;
  forced: boolean;
}

/** Thrown when `forget` targets an id that does not exist (→ INVALID_PARAMS to the MCP caller). */
export class MemoryNotFoundError extends Error {
  constructor(public readonly id: string) {
    super(`Memory ${id} not found`);
    this.name = 'MemoryNotFoundError';
  }
}

export async function handleForget(args: ForgetArgs, backend: RagBackend): Promise<ForgetOutput> {
  const result = await backend.deleteLesson(args.id, { force: args.force });
  if (!result.deleted) throw new MemoryNotFoundError(args.id);
  return { deleted: true, id: args.id, forced: result.forced };
}
