/**
 * `set_goal` MCP tool (GS.1) — the goal-subsystem's write floor.
 *
 * Sets or updates THIS session's goal: the dynamic objective that says what
 * must be completed before the work is done. It persists across turns (so a
 * later completion check — GS.5 — can read it). On first set it mints an id +
 * createdAt; subsequent calls update the same goal in place (id/createdAt kept,
 * updatedAt bumped).
 *
 * This is the MCP-floor surface (works on every harness because opensquid IS an
 * MCP server). Higher-enforcement surfaces (native /goal command, hook
 * injection) are separate layers; the MCP floor is the guaranteed one.
 *
 * Session resolution mirrors log_phase: resolve the real session id; a null
 * session is a loud error (you cannot set a goal with no session).
 *
 * Imports from: node:crypto, zod, runtime/hooks/session_id, runtime/goal_state.
 * Imported by: mcp/server.ts (handler map).
 */

import { randomBytes } from 'node:crypto';

import { z } from 'zod';

import { readGoalState, writeGoalState, type GoalState } from '../../runtime/goal_state.js';
import { resolveMcpSessionId } from '../../runtime/hooks/session_id.js';

export const SetGoalSchema = z.object({
  text: z
    .string()
    .min(1)
    .max(500)
    .describe('The session goal — what must be completed before the work is done.'),
  status: z
    .enum(['active', 'completed', 'cancelled'])
    .optional()
    .describe(
      'Goal status; omitted preserves the existing status (or defaults to active on first set).',
    ),
});

export type SetGoalArgs = z.infer<typeof SetGoalSchema>;

export type SetGoalOutput = GoalState;

/** Injection seams so tests are deterministic (no clock / randomness reliance). */
export interface SetGoalDeps {
  now?: () => string;
  genId?: () => string;
}

export async function handleSetGoal(
  args: SetGoalArgs,
  deps: SetGoalDeps = {},
): Promise<SetGoalOutput> {
  const sessionId = await resolveMcpSessionId();
  if (sessionId === null) {
    throw new Error(
      'set_goal: cannot resolve session — no CLAUDE_SESSION_ID env, no ' +
        'OPENSQUID_SESSION_ID env, and .current-session absent.',
    );
  }
  const now = (deps.now ?? (() => new Date().toISOString()))();
  const existing = await readGoalState(sessionId);
  const goal: GoalState = existing
    ? // Omitted status PRESERVES the existing one — a text-only update must not
      // silently reset a completed/cancelled goal back to active.
      { ...existing, text: args.text, status: args.status ?? existing.status, updatedAt: now }
    : {
        id: (deps.genId ?? (() => `goal-${randomBytes(8).toString('hex')}`))(),
        text: args.text,
        status: args.status ?? 'active',
        createdAt: now,
        updatedAt: now,
      };
  await writeGoalState(sessionId, goal);
  return goal;
}
