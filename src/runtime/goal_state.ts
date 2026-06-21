/**
 * Goal state (GS.1) — structured, persistent, per-session goal storage.
 *
 * The goal-subsystem's MCP floor (set_goal/get_goal) reads/writes here. A goal
 * is the session's dynamic objective: what must be completed before the work is
 * done. It persists across turns (so it can answer "are we done?") under the
 * same session-state layout every other session writer uses:
 *
 *   ~/.opensquid/sessions/<session-id>/state/goal.json   (single JSON value)
 *
 * GS.1 is intentionally minimal: ONE goal per session + read/write helpers.
 * The coding-pack scanner (GS.4) and completion semantics (GS.5) are later
 * layers that build ON this state; they are NOT implemented here.
 *
 * Fault-tolerance mirrors phase_ledger/read_state: a missing or malformed file
 * collapses to `null` (never throws on read); writes are atomic (tmp + rename).
 *
 * Imports from: node:fs/promises, runtime/paths, runtime/atomic_write.
 * Imported by: mcp/tools/set_goal.ts, mcp/tools/get_goal.ts.
 */

import { readFile } from 'node:fs/promises';

import { atomicWriteFile } from './atomic_write.js';
import { sessionStateFile } from './paths.js';

/** Lifecycle of a goal. GS.1 persists whatever is set; transition rules are GS.5. */
export type GoalStatus = 'active' | 'completed' | 'cancelled';

export interface GoalState {
  /** Stable id, minted on first set (`goal-<16 hex>`). */
  id: string;
  /** What must be completed before the work is done. */
  text: string;
  status: GoalStatus;
  /** ISO 8601 — set once on first write. */
  createdAt: string;
  /** ISO 8601 — bumped on every write. */
  updatedAt: string;
}

/** State key under `sessions/<id>/state/`. */
export const GOAL_STATE_KEY = 'goal';

function isGoalState(value: unknown): value is GoalState {
  if (value === null || typeof value !== 'object') return false;
  const g = value as Record<string, unknown>;
  return (
    typeof g.id === 'string' &&
    typeof g.text === 'string' &&
    (g.status === 'active' || g.status === 'completed' || g.status === 'cancelled') &&
    typeof g.createdAt === 'string' &&
    typeof g.updatedAt === 'string'
  );
}

/**
 * Read the session's current goal, or `null` if unset / unreadable / malformed.
 * Never throws (matches read_state + phase_ledger fault-tolerance).
 */
export async function readGoalState(sessionId: string): Promise<GoalState | null> {
  try {
    const raw = await readFile(sessionStateFile(sessionId, GOAL_STATE_KEY), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return isGoalState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Persist the session's goal atomically (tmp + rename, parent dirs created). */
export async function writeGoalState(sessionId: string, goal: GoalState): Promise<void> {
  await atomicWriteFile(sessionStateFile(sessionId, GOAL_STATE_KEY), JSON.stringify(goal, null, 2));
}
