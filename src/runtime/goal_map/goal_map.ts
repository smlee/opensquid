/**
 * GOAL-MAPPER.1 — the goal-map: the SINGLE SOURCE OF TRUTH for the top-level goal, on v2.
 *
 * Project-scoped (cross-session, NOT per-session) single-writable-home, holding the goal + a session
 * CLAIM (reassignable on handoff) + per-slice worksheets. This is the goal-anchor the process-FSM
 * lacks — drift is measured against it. OBSERVE-DON'T-CONTROL: this module READS state + writes its
 * OWN store; it never advances FSM state nor publishes on the bus, so it structurally cannot taint the FSM.
 *
 * Persistence mirrors `fsm_state` (atomicWriteFile + JSON). The home is the project scope root
 * (`resolveProjectScopeRoot`), falling back to user scope when no project is in effect.
 */
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { atomicWriteFile } from '../atomic_write.js';
import { resolveProjectScopeRoot, resolveUserScopeRoot } from '../paths.js';
import type { Worksheet } from './mapper.js';

export interface GoalClaim {
  sessionId: string;
  at: string; // ISO
}

export interface GoalMap {
  goal: string; // the single source of truth — the top-level objective
  createdAt: string; // ISO
  claim: GoalClaim | null; // the owning session (reassignable on handoff)
  worksheets: Worksheet[]; // per-slice checkpoints, in order
}

/** Project-scoped single-writable-home (cross-session); falls back to user scope when no project. */
const goalMapPath = async (cwd: string): Promise<string> =>
  join((await resolveProjectScopeRoot(cwd)) ?? resolveUserScopeRoot(), 'goal-map.json');

export async function readGoalMap(cwd: string): Promise<GoalMap | null> {
  try {
    return JSON.parse(await readFile(await goalMapPath(cwd), 'utf8')) as GoalMap;
  } catch {
    return null; // absent / malformed → no goal yet
  }
}

export async function writeGoalMap(cwd: string, gm: GoalMap): Promise<void> {
  const p = await goalMapPath(cwd);
  await mkdir(dirname(p), { recursive: true });
  await atomicWriteFile(p, JSON.stringify(gm, null, 2));
}

/** Take/refresh the claim for `sessionId`. PURE. */
export function claimGoalMap(gm: GoalMap, sessionId: string, now: Date): GoalMap {
  return { ...gm, claim: { sessionId, at: now.toISOString() } };
}

/**
 * Reassign the goal-map to `sessionId`. A LIVE claim by a DIFFERENT session requires `force`.
 * PURE — the "force is legitimate ONLY when the prior session-end was unmarked" policy lives in the
 * CALLER (it reads `readShutdownMarker(priorSession)`: present = clean release → no force needed;
 * absent = crashed/abandoned → force allowed). This fn enforces only "force to override a live
 * foreign claim".
 */
export function reassignGoalMap(
  gm: GoalMap,
  sessionId: string,
  now: Date,
  opts: { force: boolean },
): GoalMap {
  if (gm.claim !== null && gm.claim.sessionId !== sessionId && !opts.force) {
    throw new Error(
      `goal-map claimed by ${gm.claim.sessionId}; reassign to ${sessionId} requires force`,
    );
  }
  return claimGoalMap(gm, sessionId, now);
}
