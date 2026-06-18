/**
 * P0.3 — persist the Progress-floor counters across short-lived hook subprocesses
 * (T-fsm-actor-runtime §P0.3).
 *
 * `ProgressFloor` is in-memory; each PostToolUse hook is a fresh process. So the EFSM's
 * counters are read from the `progress-floor` session-state key, seeded into a `ProgressFloor`,
 * observed, and written back — the same read-modify-write pattern the `tool_ledger` uses
 * (`session_state.ts:68–102`). Absent/corrupt ⇒ empty counters (never a throw).
 */
import { readFile } from 'node:fs/promises';

import { atomicWriteFile } from '../atomic_write.js';
import { sessionStateFile } from '../paths.js';
import type { FloorCounters } from './progress_floor.js';

const KEY = 'progress-floor';

const empty = (): FloorCounters => ({ exact: {}, sameTool: {}, noProgress: {} });

/** Load the persisted floor counters for a session (empty on absent/corrupt). */
export async function loadFloorState(session: string): Promise<FloorCounters> {
  try {
    const o = JSON.parse(
      await readFile(sessionStateFile(session, KEY), 'utf8'),
    ) as Partial<FloorCounters>;
    return { exact: o.exact ?? {}, sameTool: o.sameTool ?? {}, noProgress: o.noProgress ?? {} };
  } catch {
    return empty();
  }
}

/** Persist the floor counters (atomic). */
export async function saveFloorState(session: string, s: FloorCounters): Promise<void> {
  await atomicWriteFile(sessionStateFile(session, KEY), JSON.stringify(s, null, 2));
}
