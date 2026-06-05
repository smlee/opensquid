/**
 * CAT.2 — Stop-hook inbound drive (extracted from the `stop.ts` bin so it is
 * unit-testable; the bin self-runs `main()` on import).
 *
 * `maybeDriveInbound` decides whether a finished turn should be turned back
 * into a new turn by an inbound chat message: it returns the block `reason`
 * (the umbrella inbox envelope) when THIS session holds its umbrella's chat
 * lease AND has unacked inbound; null otherwise. The Stop bin, on a clean
 * (no-drift) stop, emits `{decision:'block', reason}` when this returns
 * non-null — blocking the stop and feeding the inbound as the next turn.
 *
 * Lease gate (invariant #6): only the umbrella's live (lease-holding) session
 * drives — a second same-umbrella session stays local-only, so a chat message
 * drives exactly one session. The drain ACKS-BEFORE-RETURN, so a driven message
 * never re-drives (the durable loop guard). Fail-open: null on any error.
 *
 * Imports from: ../../channels/routing, ../chat/inbox_drain, ../chat/session_routing.
 * Imported by: src/runtime/hooks/stop.ts + tests.
 */

import { loadChannelsConfig, resolveUmbrellaForCwd } from '../../channels/routing.js';
import { drainUmbrellaInbox, peekUmbrellaInbox } from '../chat/inbox_drain.js';
import { resolveLiveSessionId } from '../chat/session_routing.js';

import { markChatDriven } from './stop_stream.js';

/** Extract the session cwd from a Stop payload (Claude Code provides `cwd`). */
export function extractCwd(raw: string): string {
  try {
    const obj = JSON.parse(raw) as { cwd?: string };
    return typeof obj.cwd === 'string' && obj.cwd.length > 0 ? obj.cwd : process.cwd();
  } catch {
    return process.cwd();
  }
}

/**
 * Return the inbound envelope to drive a turn on (block `reason`), or null.
 * See the module header for the lease + ack semantics.
 */
export async function maybeDriveInbound(sessionId: string, cwd: string): Promise<string | null> {
  try {
    const cfg = await loadChannelsConfig().catch(() => null);
    const umbrellaId = cfg === null ? null : resolveUmbrellaForCwd(cfg, cwd);
    if (umbrellaId === null || umbrellaId === '') return null;
    // Lease holder = delivery target. Only the umbrella's live session drives.
    const live = await resolveLiveSessionId(umbrellaId);
    if (live !== sessionId) return null;
    const envelope = await drainUmbrellaInbox(sessionId, cwd);
    if (envelope.length === 0) return null;
    // CAT.3: mark this umbrella's turn chat-driven so the NEXT Stop streams the
    // agent's answer back to the source topic.
    await markChatDriven(umbrellaId, sessionId);
    return envelope;
  } catch {
    return null;
  }
}

/**
 * READ-ONLY twin of {@link maybeDriveInbound} (T-CHAT-INBOUND-SURFACE-MIDRUN SF.2).
 * Returns the umbrella inbox envelope for the lease-holding session WITHOUT acking and
 * WITHOUT marking the turn chat-driven — for the Stop hook's drift branch to SURFACE a
 * mid-run user message in the drift stderr while the run continues. Because it does not ack,
 * the message still DRIVES a proper response turn at the next clean stop (via
 * `maybeDriveInbound`). Lease-gated like the drive (only the live session surfaces, so a
 * second same-umbrella session never double-surfaces). Fail-open: null on any error.
 */
export async function maybePeekInbound(sessionId: string, cwd: string): Promise<string | null> {
  try {
    const cfg = await loadChannelsConfig().catch(() => null);
    const umbrellaId = cfg === null ? null : resolveUmbrellaForCwd(cfg, cwd);
    if (umbrellaId === null || umbrellaId === '') return null;
    // Lease holder = delivery target. Only the umbrella's live session surfaces.
    const live = await resolveLiveSessionId(umbrellaId);
    if (live !== sessionId) return null;
    const envelope = await peekUmbrellaInbox(sessionId, cwd);
    return envelope.length === 0 ? null : envelope;
  } catch {
    return null;
  }
}
