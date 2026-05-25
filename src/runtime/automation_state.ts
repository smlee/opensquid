/**
 * Automation-mode session flag — file-existence flip for "is this session in
 * an automation loop right now?" (G.12).
 *
 * Flag location: `~/.opensquid/sessions/<session-id>/automation.flag` — sits
 * alongside `session_state.json` under the same `sessionStateDir(...)` root
 * so the `OPENSQUID_HOME` test seam extends to it automatically. The file's
 * contents are intentionally not load-bearing (we only check EXISTENCE), so
 * we write an ASCII timestamp purely for human-debuggability when poking the
 * directory by hand.
 *
 * Behavior contract:
 *   - `setAutomationFlag(sessionId)`   — mkdir -p + writeFile (idempotent;
 *                                        re-setting refreshes the timestamp).
 *   - `clearAutomationFlag(sessionId)` — unlink; ENOENT swallowed (idempotent).
 *   - `isAutomationFlagSet(sessionId)` — `fs.stat`; ENOENT → false. ANY other
 *                                        error also returns false (fail-safe:
 *                                        a permissions glitch inside a hook
 *                                        bin should not crash the parent
 *                                        agent's tool call — we'd rather miss
 *                                        the automation signal than block).
 *
 * The env-var override (`OPENSQUID_AUTOMATION=1`) is checked by the
 * `is_automation_mode` primitive, NOT here — this module deals only with the
 * flag-file lifecycle. Both signals OR together at the primitive boundary.
 *
 * Imports from: node:fs/promises, node:path, ./paths.js.
 * Imported by: src/functions/is_automation_mode.ts, src/setup/cli/automation.ts.
 */

import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { sessionStateDir } from './paths.js';

/** Absolute path to the automation flag file for the given session id. */
export const automationFlagPath = (sessionId: string): string =>
  // `sessionStateDir` returns `.../sessions/<id>/state`; the flag sits one
  // level up at `.../sessions/<id>/automation.flag` so it's discoverable
  // without colliding with the session_state.json key namespace.
  join(dirname(sessionStateDir(sessionId)), 'automation.flag');

/** Write the flag file (mkdir -p first). Idempotent. */
export async function setAutomationFlag(sessionId: string): Promise<void> {
  const path = automationFlagPath(sessionId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${new Date().toISOString()}\n`, 'utf8');
}

/** Remove the flag file. ENOENT is swallowed — idempotent. */
export async function clearAutomationFlag(sessionId: string): Promise<void> {
  try {
    await unlink(automationFlagPath(sessionId));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

/**
 * Returns true iff the flag file exists. ENOENT (and every other stat error)
 * → false: hooks must NEVER throw at the parent agent over a missing flag.
 */
export async function isAutomationFlagSet(sessionId: string): Promise<boolean> {
  try {
    await stat(automationFlagPath(sessionId));
    return true;
  } catch {
    return false;
  }
}
