/**
 * `forget` MCP tool — delete a memory by id with user-authored immunity.
 *
 * G.3 architectural exception (T.1.H read-only invariant): destruction
 * must remain user-controllable. The user-authored-immunity invariant
 * (`feedback_user_authored_lessons_immune`) is enforced TWICE — once
 * at the MCP layer (existence guard via `memoryGet` so a NOT_FOUND id
 * surfaces as `INVALID_PARAMS` before any destructive call) and once
 * at the engine layer (engine returns `USER_MEMORY_IMMUNE` -32003 if
 * the memory is user-immune and `force` is false).
 *
 * The MCP guard catches the engine's `-32003` response and rethrows it
 * as a typed `UserAuthoredImmunityError` so MCP callers can branch on
 * the immunity case without parsing JSON-RPC error codes themselves.
 *
 * G.5 follow-up: a runtime rule will flag any `forget(force: true)` on
 * user-authored memory as a critical drift event requiring user
 * confirmation. G.3 ships the data path; G.5 adds the runtime guard.
 *
 * Imports from: ../../engine/client.js, zod.
 * Imported by: mcp/server.ts (handler map).
 */

import { z } from 'zod';

import { ENGINE_ERROR, RpcError } from '../../engine/client.js';
import type { EngineClient } from '../../engine/client.js';

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

export class UserAuthoredImmunityError extends Error {
  readonly kind = 'UserAuthoredImmunity';
  constructor(public readonly id: string) {
    super(`Memory ${id} is user-authored and eviction-immune. Pass force: true to delete.`);
    this.name = 'UserAuthoredImmunityError';
  }
}

export async function handleForget(args: ForgetArgs, engine: EngineClient): Promise<ForgetOutput> {
  // Existence pre-check: a NOT_FOUND from memoryGet surfaces as a clean
  // `INVALID_PARAMS` to the MCP caller without ever attempting delete.
  // (memoryGet's result shape does NOT include authored_by — engine owns
  // that information and enforces immunity on memoryDelete via -32003.)
  await engine.memoryGet({ id: args.id });

  try {
    const result = await engine.memoryDelete({ id: args.id, force: args.force });
    return { deleted: true, id: args.id, forced: result.forced };
  } catch (e) {
    if (e instanceof RpcError && e.code === ENGINE_ERROR.USER_MEMORY_IMMUNE) {
      throw new UserAuthoredImmunityError(args.id);
    }
    throw e;
  }
}
