/**
 * Runtime failure handling — three-stage pattern (Task 1.18).
 *
 * Per `docs/opensquid-real-design.md` §"Runtime failure handling":
 *
 *   Stage 1: validate-at-load — fires from the pack loader at session
 *            start (lives in Phase 2; surfaces config errors to the user
 *            BEFORE any rule evaluation runs).
 *   Stage 2: runtime-notify   — when a `notify_and_pause` policy fires
 *            mid-session, multicast the verdict to the user's channels.
 *   Stage 3: pause-for-user   — persist a session-level pause marker so
 *            that subsequent hook invocations short-circuit until the
 *            user resumes.
 *
 * This module owns Stages 2 + 3. Stage 1 is the pack loader's concern.
 *
 * ORDERING CONTRACT (C10 — no silent fail-open):
 *
 *   Write the pause-state file FIRST, then multicast. The pause file is
 *   the single source of truth for "is this session halted?" — if the
 *   notification multicast throws, the runtime is still correctly paused
 *   and the user will see the halt the next time they look. Inverting
 *   this order would risk the opposite: a notification fires, the user
 *   thinks the session is paused, but the next event sails through
 *   because the pause file never landed.
 *
 *   The multicast call is therefore wrapped in `try/catch` and logged to
 *   `stderr` on failure — `notifyAndPause` must never throw out of the
 *   notification path. Pause-state write errors DO propagate, because a
 *   failed pause is a real fault the caller must handle (per C10, the
 *   alternative is silently fail-open).
 *
 * Imported by: drift_response dispatcher (Task 1.6 wiring) and the hook
 * layer (Task 1.7) for the `isPaused` short-circuit check.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { NotificationRouter } from '../channels/router.js';
import type { RoutingConfig } from '../channels/types.js';

import { sessionStateFile } from './paths.js';
import type { PauseState } from './types.js';

/**
 * Pause the session and notify the user. Stage 2 + Stage 3 in one call.
 *
 * Writes `sessionStateFile(sessionId, 'pause')` atomically (tmp + rename
 * within the same directory, so the rename is a single inode swap on
 * POSIX), then attempts to multicast an `error`-severity message. If
 * multicast throws, the error is logged to `stderr` and swallowed — the
 * session is already paused, which is the load-bearing side effect.
 */
export async function notifyAndPause(
  reason: string,
  sessionId: string,
  router: NotificationRouter,
  routing: RoutingConfig,
  meta: { ruleId?: string; packId?: string } = {},
): Promise<void> {
  const state: PauseState = {
    reason,
    triggeredAt: new Date().toISOString(),
    ...(meta.ruleId !== undefined ? { ruleId: meta.ruleId } : {}),
    ...(meta.packId !== undefined ? { packId: meta.packId } : {}),
  };
  const path = sessionStateFile(sessionId, 'pause');
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await rename(tmp, path);

  // Multicast LAST. Failures here are non-fatal — the pause file is the
  // source of truth and is already on disk. Logging to stderr surfaces
  // the failure without blowing up the runtime.
  try {
    await router.multicast(
      'error',
      null,
      { text: `opensquid paused: ${reason}`, severity: 'error' },
      routing,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `opensquid: pause notification failed (state still written): ${message}\n`,
    );
  }
}

/**
 * Cheap existence check used by hook dispatch to short-circuit paused
 * sessions. Returns `true` iff `sessionStateFile(sessionId, 'pause')`
 * exists and is readable. Never throws — any I/O error is treated as
 * "not paused" so transient FS issues don't block recovery flows.
 */
export async function isPaused(sessionId: string): Promise<boolean> {
  try {
    await readFile(sessionStateFile(sessionId, 'pause'), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the full `PauseState` for a paused session, or `null` if the
 * session is not paused / the file is unreadable / the JSON is invalid.
 *
 * Soft failure (returns `null` on parse error) is intentional: a corrupt
 * pause file is recoverable by the user (delete the file) and we never
 * want this read path to crash the hook layer.
 */
export async function readPauseState(sessionId: string): Promise<PauseState | null> {
  try {
    const raw = await readFile(sessionStateFile(sessionId, 'pause'), 'utf8');
    return JSON.parse(raw) as PauseState;
  } catch {
    return null;
  }
}
