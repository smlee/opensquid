/**
 * `get_goal` MCP tool (GS.1) — the goal-subsystem's read floor.
 *
 * Returns THIS session's current goal, or `null` if none is set. Read-only,
 * fault-tolerant: a null session or a missing/malformed goal file both collapse
 * to `null` (matches read_state's graceful-empty contract).
 *
 * Imports from: zod, runtime/hooks/session_id, runtime/goal_state.
 * Imported by: mcp/server.ts (handler map).
 */

import { z } from 'zod';

import { readGoalState, type GoalState } from '../../runtime/goal_state.js';
import { resolveMcpSessionId } from '../../runtime/hooks/session_id.js';

export const GetGoalSchema = z.object({});

export type GetGoalArgs = z.infer<typeof GetGoalSchema>;

export async function handleGetGoal(): Promise<GoalState | null> {
  const sessionId = await resolveMcpSessionId();
  if (sessionId === null) return null;
  return readGoalState(sessionId);
}
