/**
 * GOAL-MAPPER.2 — `set_goal`: declare/update the project GOAL (the single source of truth) the
 * per-slice worksheets anchor to. A user-callable MCP write tool (the `memorize` shape).
 *
 * cwd is SESSION-derived (the MCP server is persistent + session-agnostic): resolve the session like
 * `log_phase` (`resolveMcpSessionId` → env `CLAUDE_SESSION_ID` / `.current-session`), then its recorded
 * cwd (`readSessionCwd`). Updates the goal + claims the goal-map for this session; preserves any
 * existing worksheets.
 */
import { z } from 'zod';

import { resolveMcpSessionId } from '../../runtime/hooks/session_id.js';
import { OPENSQUID_HOME } from '../../runtime/paths.js';
import { readSessionCwd } from '../../runtime/session_state.js';
import { claimGoalMap, readGoalMap, writeGoalMap } from '../../runtime/goal_map/goal_map.js';

export const SetGoalSchema = z.object({ goal: z.string().min(1) }).strict();
export type SetGoalArgs = z.infer<typeof SetGoalSchema>;

export interface SetGoalOutput {
  ok: true;
  goal: string;
}

export async function handleSetGoal(
  args: SetGoalArgs,
  now: Date = new Date(),
): Promise<SetGoalOutput> {
  const session = await resolveMcpSessionId();
  if (session === null) {
    throw new Error(
      'set_goal: cannot resolve session (no CLAUDE_SESSION_ID env, no .current-session)',
    );
  }
  const cwd = (await readSessionCwd(session)) ?? OPENSQUID_HOME();
  const existing = await readGoalMap(cwd);
  const base = existing ?? {
    goal: args.goal,
    createdAt: now.toISOString(),
    claim: null,
    worksheets: [],
  };
  // Update the goal (single source of truth) + claim the goal-map for this session; keep worksheets.
  const gm = claimGoalMap({ ...base, goal: args.goal }, session, now);
  await writeGoalMap(cwd, gm);
  return { ok: true, goal: args.goal };
}
