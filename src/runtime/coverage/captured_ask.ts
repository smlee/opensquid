/**
 * CFD.2 / AD.1 — the captured-ask anchor.
 *
 * At `scope_start` the coding-flow captures the user's verbatim prompt(s) for the task into a per-session KV
 * (`captured-ask-coding-flow`). This is the IMMUTABLE reference the SCOPE on-topic criterion (rubric §5) and
 * the AUTHOR re-anchor (author rubric §2) check against: a scoped/authored element that does not trace to the
 * captured ask is DRIFT. The ask is the UNION of the task's user turns until scope freezes — then immutable,
 * so a frozen scope cannot be silently widened. Same `sessionStateFile` KV pattern the FSM / `PHASE_KEY` use
 * (phase_inject.ts:40-57,103).
 *
 * Spec: docs/tasks/T-anti-drift-gate.md AD.1; pre-research §4.1.
 */
import { readFile } from 'node:fs/promises';

import { atomicWriteFile } from '../atomic_write.js';
import { sessionStateFile } from '../paths.js';

/** The per-session KV key (mirrors phase_inject's PHASE_KEY). */
export const CAPTURED_ASK_KEY = 'captured-ask-coding-flow';

/** Generous ceiling on the total captured text — over-cap FAILS LOUD (never a silent truncation of the
 *  anchor the gate checks against). Matches read_rubric's MAX_RUBRIC ceiling. */
export const MAX_ASK = 64_000;

export interface CapturedAsk {
  turns: string[]; // the user's verbatim prompts for this task, in order (the union)
  frozen: boolean; // true once scope is complete — appendAsk is then a no-op
}

const empty = (): CapturedAsk => ({ turns: [], frozen: false });

/** Read the captured ask for a session, or the empty default on absent / parse error / shape mismatch. */
export async function readCapturedAsk(sessionId: string): Promise<CapturedAsk> {
  try {
    const parsed = JSON.parse(
      await readFile(sessionStateFile(sessionId, CAPTURED_ASK_KEY), 'utf8'),
    ) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'turns' in parsed &&
      'frozen' in parsed &&
      Array.isArray((parsed as { turns: unknown }).turns) &&
      typeof (parsed as { frozen: unknown }).frozen === 'boolean'
    ) {
      const turns = (parsed as { turns: unknown[] }).turns;
      if (turns.every((t): t is string => typeof t === 'string')) {
        return { turns: [...turns], frozen: (parsed as CapturedAsk).frozen };
      }
    }
  } catch {
    /* absent / parse error → empty default */
  }
  return empty();
}

/**
 * Append a user turn to the captured ask (the union). NO-OP once frozen (a frozen scope cannot be widened)
 * and NO-OP on an exact duplicate (a re-submit / retry must not bloat the anchor). FAILS LOUD if the append
 * would exceed MAX_ASK — never a silent truncation of the reference the drift gate checks against.
 */
export async function appendAsk(sessionId: string, prompt: string): Promise<void> {
  const current = await readCapturedAsk(sessionId);
  if (current.frozen) return; // frozen → immutable
  if (current.turns.includes(prompt)) return; // exact-dup → no bloat
  const turns = [...current.turns, prompt];
  const total = turns.reduce((n, t) => n + t.length, 0);
  if (total > MAX_ASK) {
    throw new Error(
      `captured-ask over cap (${String(total)} > ${String(MAX_ASK)} chars) — refusing to truncate the drift anchor`,
    );
  }
  await atomicWriteFile(
    sessionStateFile(sessionId, CAPTURED_ASK_KEY),
    JSON.stringify({ turns, frozen: false }),
  );
}

/** Freeze the captured ask at scope-complete — subsequent appendAsk calls are no-ops. Idempotent. */
export async function freezeAsk(sessionId: string): Promise<void> {
  const current = await readCapturedAsk(sessionId);
  if (current.frozen) return;
  await atomicWriteFile(
    sessionStateFile(sessionId, CAPTURED_ASK_KEY),
    JSON.stringify({ turns: current.turns, frozen: true }),
  );
}

/** Reset the captured ask for a per-task re-arm — BOTH FSM reset edges: `task_unscoped` from `*` (the
 *  FU.11 mid-session task switch, fsm.yaml:44) and `phases_complete --scope_start--> scoping` (fsm.yaml:52).
 *  Without this a second task inherits the first task's FROZEN ask (appendAsk is a no-op while frozen). */
export async function resetAsk(sessionId: string): Promise<void> {
  await atomicWriteFile(sessionStateFile(sessionId, CAPTURED_ASK_KEY), JSON.stringify(empty()));
}
