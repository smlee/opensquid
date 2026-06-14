/**
 * Stranded-scoping detection (RTC.4, wg-3d175ec06767).
 *
 * The codex-pause-wedge's cause-1: a coding-flow FSM that entered `scoping`/`researching` long ago
 * (e.g. a codex thread resumed across days) and was never advanced — so the pause guards stay armed
 * forever on a thread that is only answering questions. RTC.2 prevents NEW stranding (a research
 * turn never arms), but a PRE-EXISTING orphaned scoping persists across a resume. This detects that
 * orphan at SessionStart(resume) so it can be reset to idle (`clearFsmState`).
 *
 * The triple-gate is deliberately conservative so it NEVER resets a live, legitimate scoping:
 *   1. FSM is at `scoping`/`researching`;
 *   2. STALE — the FSM's `started_at` is older than STALE_MS relative to the resume, AND the
 *      tool-ledger shows no activity this turn (a freshly-resumed live scoping has recent activity);
 *   3. NO work artifacts — neither `coding-flow-pre-research-path` nor `coding-flow-spec-path` is
 *      recorded (an in-flight work track that already produced an artifact is never an orphan).
 * Only when all three hold is the scoping an orphan.
 */

import { readFsmStateFile, readFsmStateRaw } from '../fsm_state.js';
import { readSessionStateValue, readSessionToolLedger } from '../session_state.js';

/** A scoping older than this at resume, with no activity + no artifacts, is treated as orphaned. */
export const STALE_SCOPING_MS = 6 * 60 * 60 * 1000; // 6 hours

export async function isStrandedScoping(sessionId: string, resumeAtIso: string): Promise<boolean> {
  const st = await readFsmStateRaw(sessionId, 'coding-flow');
  if (st !== 'scoping' && st !== 'researching') return false;

  const file = await readFsmStateFile(sessionId, 'coding-flow');
  if (file === null) return false;
  const ageMs = Date.parse(resumeAtIso) - Date.parse(file.started_at);
  if (!(ageMs > STALE_SCOPING_MS)) return false; // NaN-safe: a bad/recent started_at → not stale

  const ledger = await readSessionToolLedger(sessionId, 'current_turn');
  if (ledger.tools.length > 0) return false; // recent activity this turn → a live scoping

  const noArtifacts =
    (await readSessionStateValue(sessionId, 'coding-flow-pre-research-path')) === null &&
    (await readSessionStateValue(sessionId, 'coding-flow-spec-path')) === null;
  return noArtifacts;
}
