/**
 * T-PACK-FSM-STANDARDIZATION slice A3 — per-session pack-FSM runtime state.
 *
 * The generic, total-transition counterpart to `chain_state.ts`: instead of one
 * hardcoded global stage tracker with a permissive `transitionChainStage`, this
 * persists the current state of ANY pack's declared FSM (`Pack.fsm`, slice A2)
 * per (session, pack) and advances it through the validated `step` function
 * (slice A1) — so an advance can ONLY move along a declared transition, and a
 * loop-back edge is honored.
 *
 * Persistence mirrors `chain_state` exactly (sessionStateFile + atomicWriteFile
 * + no-throw reads), keyed `fsm-<packName>` so multiple packs' machines coexist
 * in one session. Pure where it can be: `step` does the transition logic;
 * `advanceFsmState` only adds I/O (read current → step → persist-if-moved) and
 * takes `now`/`evalWhen` as params so it stays deterministic + testable.
 *
 * Imported by: slice A3b primitives (`read_fsm_state` / `advance_fsm`) + the
 * SessionEnd cleanup; tests.
 */
import { readFile, unlink } from 'node:fs/promises';

import { atomicWriteFile } from './atomic_write.js';
import { type Fsm, type FlatStepResult, stepFlat } from './fsm.js';
import { appendTransition } from './observe/transition_log.js';
import { observeGoalTransition } from './goal_map/observe.js';
import { sessionStateFile } from './paths.js';

export interface FsmHistoryEntry {
  state: string;
  /** ISO-8601 timestamp the machine ENTERED this state. */
  at: string;
}

export interface FsmStateFile {
  state: string;
  /** ISO timestamp the machine entered the CURRENT state. */
  started_at: string;
  /** Append-only audit trail of every state entered. */
  history: FsmHistoryEntry[];
}

function fsmKey(packName: string): string {
  return `fsm-${packName}`;
}

function isFsmStateFile(o: unknown): o is FsmStateFile {
  if (o === null || typeof o !== 'object') return false;
  const obj = o as Record<string, unknown>;
  return typeof obj.state === 'string' && Array.isArray(obj.history);
}

/**
 * Read the persisted current state for `(session, pack)`. Defaults to
 * `fsm.initial` when absent/unreadable/malformed, OR when the persisted state
 * is no longer a declared state (the pack's FSM changed) — a self-healing
 * no-throw read matching `readChainStage`.
 */
export async function readFsmState(sessionId: string, packName: string, fsm: Fsm): Promise<string> {
  try {
    const raw = await readFile(sessionStateFile(sessionId, fsmKey(packName)), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (isFsmStateFile(parsed) && fsm.states.includes(parsed.state)) {
      return parsed.state;
    }
  } catch {
    // ENOENT / parse error → fall through to initial.
  }
  return fsm.initial;
}

/**
 * Advance `(session, pack)`'s FSM on `event`. Reads the current state, runs the
 * total `step`, and — ONLY when the state actually transitions — persists the
 * new state + appends to history. A no-op event (no matching transition, or a
 * guard that fails) leaves the file untouched and returns `transitioned:false`.
 * Returns the full `StepResult` so the caller can react to `via`/`transitioned`.
 *
 * `now` (ISO string) is supplied by the caller for determinism; `evalWhen`
 * evaluates a transition's `when` guard (caller wires the expression engine).
 */
export async function advanceFsmState(
  sessionId: string,
  packName: string,
  fsm: Fsm,
  event: string,
  now: string,
  evalWhen?: (expr: string) => boolean,
): Promise<FlatStepResult> {
  const current = await readFsmState(sessionId, packName, fsm);
  const result = stepFlat(fsm, current, event, evalWhen); // flat pack FSM → string next-state
  const toState = result.next;
  if (result.transitioned) {
    let history: FsmHistoryEntry[] = [];
    try {
      const raw = await readFile(sessionStateFile(sessionId, fsmKey(packName)), 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (isFsmStateFile(parsed)) history = parsed.history;
    } catch {
      // no prior file — fresh history.
    }
    const next: FsmStateFile = {
      state: toState,
      started_at: now,
      history: [...history, { state: toState, at: now }],
    };
    await atomicWriteFile(
      sessionStateFile(sessionId, fsmKey(packName)),
      JSON.stringify(next, null, 2),
    );
    // P0.2 — observability seed: one record per ACTUAL advance, downstream of persistence.
    // Wrapped: an observe failure must NEVER break an advance (the return + state write stand).
    try {
      await appendTransition({
        session: sessionId,
        pack: packName,
        from: current,
        to: toState,
        on: event,
        at: now,
        via: result.via ?? -1, // StepResult.via is number|null; stays never reach here (defensive)
      });
    } catch {
      /* observe never breaks an advance */
    }
    // GOAL-MAPPER.2 — a second wrapped observe: start/link the per-slice worksheet (observe-don't-control).
    // The goal_map module owns the 'scoping'/'tasks_loaded' rules; this stays generic.
    try {
      await observeGoalTransition({ session: sessionId, to: toState, now });
    } catch {
      /* observe never breaks an advance */
    }
  }
  return result;
}

/**
 * Read the persisted state string for `(session, pack)` WITHOUT needing the
 * pack's FSM definition — for CROSS-PACK reads where one pack's rule queries
 * another pack's lifecycle state (e.g. a pack gating on the workflow stage).
 * Returns null when the machine hasn't started (file absent) or is unreadable,
 * so the caller distinguishes "no state yet" from any concrete state.
 */
export async function readFsmStateRaw(sessionId: string, packName: string): Promise<string | null> {
  try {
    const raw = await readFile(sessionStateFile(sessionId, fsmKey(packName)), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (isFsmStateFile(parsed)) return parsed.state;
  } catch {
    // absent / parse error → null
  }
  return null;
}

/**
 * Read the FULL persisted FSM-state file (`state` + `started_at` + `history`) for
 * `(session, pack)`, or null when absent/unreadable. Unlike `readFsmStateRaw` (state string
 * only), this exposes `started_at` for staleness checks (RTC.4 resume-orphan reset, wg-3d175ec06767).
 */
export async function readFsmStateFile(
  sessionId: string,
  packName: string,
): Promise<FsmStateFile | null> {
  try {
    const parsed = JSON.parse(
      await readFile(sessionStateFile(sessionId, fsmKey(packName)), 'utf8'),
    ) as unknown;
    return isFsmStateFile(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * FAC-CUT.5b.2 — persist an ALREADY-STEPPED actor's current state, in the `FsmStateFile` format keyed
 * `fsm-<pack>` (so v2 actor state coexists with v1 pack FSMs + is readable by `readFsmState`/the handoff).
 * Unlike `advanceFsmState`, this does NOT step — the v2 `V2ObservedActor` already ran the transition; this
 * only writes the new `current` + appends history. Reuses the same atomic I/O.
 */
export async function persistActorState(
  sessionId: string,
  packName: string,
  current: string,
  now: string,
): Promise<void> {
  const prior = await readFsmStateFile(sessionId, packName);
  const history: FsmHistoryEntry[] = prior ? prior.history : [];
  const next: FsmStateFile = {
    state: current,
    started_at: now,
    history: [...history, { state: current, at: now }],
  };
  await atomicWriteFile(
    sessionStateFile(sessionId, fsmKey(packName)),
    JSON.stringify(next, null, 2),
  );
}

/** Remove a pack's FSM-state file (SessionEnd cleanup). ENOENT swallowed. */
export async function clearFsmState(sessionId: string, packName: string): Promise<void> {
  try {
    await unlink(sessionStateFile(sessionId, fsmKey(packName)));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}
