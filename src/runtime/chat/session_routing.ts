/**
 * Session-routing resolver — maps a `projectUuid` to its currently-live
 * Claude Code session id by reading the `live-session.lease` heartbeat file
 * (T-L3-LOOP LL.2).
 *
 * The lease file (`src/runtime/chat/live_session_lease.ts`) is written by
 * `opensquid chat watch` every HEARTBEAT_MS (30s) and considered stale after
 * STALE_MS (90s). LL.2 wraps the existing primitive into a project-keyed
 * lookup so the inbound watcher (LL.3) and the UPS hook (LL.4) can answer
 * "which session should receive this project's inbox?" without re-implementing
 * freshness logic.
 *
 * Semantics:
 *   - Fresh lease (refreshed_at within last 90s) → returns lease.session_id
 *   - Stale lease (older than 90s) → returns null (per L3, L7 — silent drop;
 *     LL.3 logs the violation at the action context)
 *   - Missing lease (file ENOENT) → returns null
 *   - Corrupt lease (malformed JSON or missing required fields) → returns null
 *
 * `resolveAllLiveProjects` is the multi-project enumeration used by the LL.3
 * chokidar watcher to know which project-uuid roots to attach to at boot
 * (and re-scan on a stale-detected event).
 *
 * **No logging from this module.** The resolver is a pure lookup; callers
 * (LL.3 / LL.4) log with action context so the failure message includes
 * what was being attempted ("dropping message X" vs just "lease stale").
 *
 * At-most-once-delayed-by-one-message semantic: the lease file CAN be
 * written mid-read. `readLease` does `JSON.parse` after `readFile`; an
 * interleaved write produces a parse error which `readLease` swallows +
 * returns null. The next resolver call (next message) succeeds. Documented
 * here so callers don't add defensive retry loops.
 *
 * Imports from: node:fs/promises, node:path, ../paths, ./live_session_lease.
 * Imported by: src/runtime/chat/inbound_watch.ts (LL.3); LL.4 UPS hook;
 *   tests.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { OPENSQUID_HOME } from '../paths.js';

import { isLeaseFresh, readLease, type LiveSessionLease } from './live_session_lease.js';

/**
 * Return the fresh sessionId for a project, or null if no live session.
 * Pure function over the lease file (one fs.readFile + a comparison).
 *
 * `now` is injected for test determinism; defaults to `new Date()`.
 */
export async function resolveLiveSessionId(
  projectUuid: string,
  now: Date = new Date(),
): Promise<string | null> {
  const lease = await readLease(projectUuid);
  if (lease === null) return null;
  if (!isLeaseFresh(lease, now)) return null;
  if (typeof lease.session_id !== 'string' || lease.session_id.length === 0) return null;
  return lease.session_id;
}

export interface LiveProjectBinding {
  projectUuid: string;
  sessionId: string;
  refreshedAt: string;
}

/**
 * Enumerate every project with a fresh lease. Used by LL.3 watcher at boot
 * to know which projects to chokidar-tail. Sorted by `refreshedAt` ascending
 * (oldest-first) so log output stays stable across reruns.
 *
 * ENOENT on `~/.opensquid/projects/` returns `[]` (watcher boot before any
 * project exists). Non-directory entries are silently skipped (their
 * `readLease` returns null).
 */
export async function resolveAllLiveProjects(
  now: Date = new Date(),
): Promise<LiveProjectBinding[]> {
  const projectsRoot = join(OPENSQUID_HOME(), 'projects');
  let entries: string[];
  try {
    entries = await readdir(projectsRoot);
  } catch {
    return [];
  }
  const out: LiveProjectBinding[] = [];
  for (const projectUuid of entries) {
    const lease = await readLease(projectUuid);
    if (lease === null) continue;
    if (!isLeaseFresh(lease, now)) continue;
    if (typeof lease.session_id !== 'string' || lease.session_id.length === 0) continue;
    out.push({
      projectUuid,
      sessionId: lease.session_id,
      refreshedAt: lease.refreshed_at,
    });
  }
  out.sort((a, b) => a.refreshedAt.localeCompare(b.refreshedAt));
  return out;
}

/** Type-export to keep call sites stable when the lease shape evolves. */
export type { LiveSessionLease };
