/**
 * T-session-end-indication (wg-a9af600828fe) — the pure builder for the SessionEnd indication line.
 *
 * The user runs one session and could not tell which session ended on `/exit` (the "phantom sibling"
 * confusion). SessionEnd must emit an unambiguous, session-naming line. Kept PURE (no I/O) so it unit-tests
 * without running the session-end hook binary's `main()`; the hook reads `readActiveTask` and passes it here.
 */
import type { ActiveTask } from '../session_state.js';

/** A single, unambiguous line naming the session that ended (+ its task, when one is/was active). */
export function sessionEndIndication(sessionId: string, active: ActiveTask | null): string {
  const id = sessionId.slice(0, 8);
  if (active === null) return `[opensquid] session ${id} ended — no active task`;
  const tid = active.taskId !== undefined ? ` [${active.taskId}]` : '';
  return `[opensquid] session ${id} ended — task "${active.subject}"${tid}`;
}
