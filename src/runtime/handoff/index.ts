/**
 * T-AUTO-HANDOFF — orchestration: collect → write all four surfaces.
 *
 * Three triggers share this one entry:
 *   1. `opensquid handoff` (cli.ts) — primary.
 *   2. SessionEnd hook — automatic backup (best-effort, after existing work).
 *   3. SessionStart lazy generation (handoff_session_start function) — the
 *      wedge-proof safety net for sessions that died without either trigger.
 *
 * Imports from: ./collect.js, ./write.js.
 * Imported by: src/cli.ts, src/runtime/hooks/session-end.ts,
 *   src/functions/handoff_session_start.ts.
 */

import { collectHandoffState } from './collect.js';
import { type WriteHandoffResult, writeHandoffSurfaces } from './write.js';

export { handoverDocPath, umbrellaRootFor } from './collect.js';
export { renderInjection } from './render.js';
export type { WriteHandoffResult } from './write.js';

export async function runHandoff(sessionId: string, cwd: string): Promise<WriteHandoffResult> {
  const state = await collectHandoffState(sessionId, cwd);
  return writeHandoffSurfaces(state);
}
