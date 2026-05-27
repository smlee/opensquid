/**
 * AP.3 — the 7-phase workflow state machine (the gate-readable half of the
 * severed writer the G-track dropped).
 *
 * `log_phase` (the MCP tool) writes TWO places: (a) the engine ledger
 * (durable, via `task.log_phase`) and (b) this per-session state, which the
 * workflow gate (AP.4) reads to decide whether a commit may proceed.
 *
 * The completeness question is "are all 7 phases logged FOR THE TASK THAT IS
 * ACTIVE RIGHT NOW" — so completeness is NOT baked in at log time (a new task
 * must not inherit the prior task's "complete"). We store the raw
 * `{ task_id, phases }` ledger here and compute `isComplete(state, activeId)`
 * at read time against the live active task. Switching to a new active task
 * resets the ledger (a `log_phase` for a different task_id starts fresh).
 *
 * Phase names are the engine's canonical set (verified against the Rust
 * `Phase::parse` validator): a mismatch would make `task.log_phase` reject the
 * call, so this constant is the single source of truth shared by the tool.
 *
 * Storage: `sessionStateFile(id, 'workflow.phases_logged')` — the standard
 * session state namespace, so the generic `read_state` primitive can read it
 * too. Atomic tmp+rename write; null-safe read (no throw).
 *
 * Imports from: node:fs/promises, node:path, ./paths.js.
 * Imported by: src/mcp/tools/log_phase.ts; src/functions/* (AP.4 gate read-side).
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { sessionStateFile } from './paths.js';

/** The engine's canonical 7-phase set (matches the Rust `Phase::parse` validator). */
export const REQUIRED_PHASES = [
  'pre_research',
  'learn',
  'code',
  'test',
  'audit',
  'post_research',
  'fix',
] as const;
export type Phase = (typeof REQUIRED_PHASES)[number];

/** Session state key (also readable via the generic `read_state` primitive). */
const PHASES_KEY = 'workflow.phases_logged';

export interface PhaseState {
  /** The active task these phases belong to. */
  task_id: string;
  /** Phases logged so far for that task (deduped, order of first log). */
  phases: string[];
}

/** Read the phase ledger, or `null` if absent/unreadable/malformed (no throw). */
export async function readPhaseState(sessionId: string): Promise<PhaseState | null> {
  try {
    const parsed = JSON.parse(
      await readFile(sessionStateFile(sessionId, PHASES_KEY), 'utf8'),
    ) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { task_id: unknown }).task_id === 'string' &&
      Array.isArray((parsed as { phases: unknown }).phases)
    ) {
      const s = parsed as { task_id: string; phases: unknown[] };
      return {
        task_id: s.task_id,
        phases: s.phases.filter((p): p is string => typeof p === 'string'),
      };
    }
    return null;
  } catch {
    return null;
  }
}

async function writePhaseState(sessionId: string, state: PhaseState): Promise<void> {
  const path = sessionStateFile(sessionId, PHASES_KEY);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await rename(tmp, path);
}

/**
 * Append a phase for `taskId`. Starts a fresh ledger when the active task
 * changed (the prior task's phases do not carry over). Idempotent per phase.
 * Returns the updated state.
 */
export async function appendPhase(
  sessionId: string,
  taskId: string,
  phase: string,
): Promise<PhaseState> {
  const prev = await readPhaseState(sessionId);
  const state: PhaseState = prev?.task_id === taskId ? prev : { task_id: taskId, phases: [] };
  if (!state.phases.includes(phase)) state.phases.push(phase);
  await writePhaseState(sessionId, state);
  return state;
}

/**
 * Complete ⟺ the ledger is for the currently-active task AND every REQUIRED
 * phase is present. A ledger for a different task (or absent) is NOT complete —
 * this is what prevents a new task from inheriting a prior task's completion.
 */
export function isComplete(state: PhaseState | null, activeTaskId: string): boolean {
  if (state?.task_id !== activeTaskId) return false;
  return REQUIRED_PHASES.every((p) => state.phases.includes(p));
}
