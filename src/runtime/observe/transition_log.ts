/**
 * P0.2 — observability seed: one append-only record per FSM advance
 * (T-fsm-actor-runtime §P0.2).
 *
 * `advanceFsmState` (fsm_state.ts) persists the new state inside `if (result.transitioned)`
 * but emits nothing a visualizer / audit stream can consume. This appends ONE record per
 * ACTUAL advance to a single per-SESSION log (`transitions.jsonl`) — all packs interleaved in
 * advance-order, so a flow's order can be reconstructed ACROSS packs (which a per-`(session,pack)`
 * log cannot). A pure observe: the emit is strictly downstream of persistence and wrapped so it
 * never breaks an advance. Seeds the same record shape the bus `transition` MessageKind (BUS.1)
 * carries on the V2 path; this is the V1 (cross-process, short-lived hooks) durable equivalent.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { sessionLogFile } from '../paths.js';

export interface TransitionRecord {
  session: string;
  pack: string;
  from: string;
  to: string;
  on: string;
  at: string;
  via: number; // StepResult.via is number|null; the caller passes `?? -1` (defensive — stays never reach here)
}

/** The per-session transition log path (`<session-state-dir>/transitions.jsonl`). */
export const transitionLogPath = (session: string): string =>
  sessionLogFile(session, 'transitions');

/**
 * Append one transition record (JSONL). `appendFile` — NOT `atomicWriteFile`, which OVERWRITES —
 * because the log is an ordered, never-rewritten stream. One shared log per session orders advances
 * across packs.
 */
export async function appendTransition(rec: TransitionRecord): Promise<void> {
  const path = transitionLogPath(rec.session);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(rec)}\n`, 'utf8');
}
