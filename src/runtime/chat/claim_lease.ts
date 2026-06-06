/**
 * Live-session umbrella lease claim (T-CHAT-AS-TERMINAL — interactive responder).
 *
 * THE fix for the interactive path: when `responder` is `session` (the default —
 * chat MIRRORS the live MCP session), the Claude Code session claims its
 * umbrella's chat lease with its OWN session id, from its own hooks
 * (SessionStart / UserPromptSubmit / Stop). The CAT.2 Stop-hook drive answers a
 * chat message only when `resolveLiveSessionId(umbrella) === thisSessionId` —
 * which now holds precisely because THIS session wrote the lease (previously the
 * lease carried `chat watch`'s id, which never matched the session, so the drive
 * silently no-op'd). It also makes the headless agent-bridge stand down: it sees
 * a fresh human-owned lease (CAT.5 ownership guard).
 *
 * acquire-if-free (invariant #6): a DIFFERENT live session already holding a
 * fresh lease is NOT stolen — this session is local-only (no chat) until that
 * lease lapses.
 *
 * In `headless` mode this is a no-op — the session yields the lease to the
 * dedicated headless responder. Fail-quiet: any error / no umbrella / unknown
 * session id ⇒ no claim, never blocks a hook.
 *
 * Imports from: ../../channels/routing, ./live_session_lease, ../paths.
 * Imported by: src/runtime/hooks/{session-start,user-prompt-submit,stop}.ts + tests.
 */

import { loadChannelsConfig, resolveUmbrellaForCwd } from '../../channels/routing.js';
import { umbrellaLiveSessionLease } from '../paths.js';

import { acquireLeaseIfFree, writeLease } from './live_session_lease.js';

/**
 * Claim/refresh the session's umbrella chat lease (acquire-if-free). Returns
 * true iff this session now holds it. No-op (false) when: the session id is
 * empty/unknown, no channels.json, the cwd resolves to no umbrella, the
 * configured `responder` is not `session`, or a different live session holds a
 * fresh lease.
 */
export async function claimUmbrellaLeaseForSession(
  sessionId: string,
  cwd: string = process.cwd(),
  opts?: { forceTakeover?: boolean },
): Promise<boolean> {
  try {
    if (sessionId === '' || sessionId === 'unknown') return false;
    const cfg = await loadChannelsConfig().catch(() => null);
    if (cfg === null) return false;
    if ((cfg.responder ?? 'session') !== 'session') return false; // headless mode → yield
    const umbrellaId = resolveUmbrellaForCwd(cfg, cwd);
    if (umbrellaId === null || umbrellaId === '') return false;
    const leasePath = umbrellaLiveSessionLease(umbrellaId);
    // The PROJECT (umbrella) is stable but the SESSION changes — every fresh start /
    // resume is a different live session. A NEW session start is the user's deliberate
    // signal "route chat HERE now", so it TAKES OVER the lease (newest-session-wins),
    // even from a still-fresh prior holder — otherwise a just-ended session's lease (or a
    // leftover heartbeat) leaves chat pinned to a session that's gone (the observed
    // stale-lease-to-dead-session bug). The MID-session heartbeat (UPS/Stop) stays
    // acquire-if-free so it never steals from a genuinely concurrent live session.
    if (opts?.forceTakeover === true) {
      await writeLease(leasePath, sessionId);
      return true;
    }
    return await acquireLeaseIfFree(leasePath, sessionId);
  } catch {
    return false;
  }
}
