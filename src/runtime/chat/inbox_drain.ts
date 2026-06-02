/**
 * Shared umbrella-inbox drain (T-CHAT-AS-TERMINAL CAT.2).
 *
 * One drain, two callers:
 *   - UserPromptSubmit hook — emits the envelope as `additionalContext`
 *     (delivery ON the user's keystroke); and
 *   - Stop hook — emits the envelope as a `{decision:'block', reason}` so the
 *     inbound message DRIVES a turn at the turn boundary (no keystroke).
 *
 * Both call this one function, so the ACK ledger is shared: a message drained
 * by either path is acked-before-return and never delivered twice (UPS won't
 * re-inject what Stop drove, and vice versa). This is the durable loop-guard
 * for the Stop-drive — only genuinely-new inbound produces a fresh envelope.
 *
 * Umbrella resolution + the read/compute/build/ack/purge flow live here (lifted
 * verbatim from the former UPS `drainInboxEnvelope`). Fail-open: any error, or a
 * cwd that resolves to no umbrella, returns '' (the caller proceeds).
 *
 * Imports from: ./inbox, ./inbox_inject, ./inbox_writer, ../../channels/routing.
 * Imported by: src/runtime/hooks/{user-prompt-submit,stop}.ts + tests.
 */

import { loadChannelsConfig, resolveUmbrellaForCwd } from '../../channels/routing.js';

import { type Platform, readAcked, readInbox } from './inbox.js';
import {
  buildAckRowsForInjected,
  buildInjectionEnvelope,
  computeUnackedRows,
  purgeOldAcks,
} from './inbox_inject.js';
import { appendAckRows, rewriteAckedAfterPurge } from './inbox_writer.js';

const INBOX_PLATFORMS: Platform[] = ['telegram', 'slack', 'discord'];

/**
 * Drain the unacked inbox rows for the session's umbrella into one envelope
 * string, ACK-BEFORE-RETURN. Returns '' when there is nothing to deliver, when
 * cwd resolves to no umbrella, or on any error (fail-open).
 *
 * `cwd` defaults to `process.cwd()`; the Stop hook passes the cwd from its
 * payload so the umbrella resolves against the session's launch dir.
 */
export async function drainUmbrellaInbox(
  sessionId: string,
  cwd: string = process.cwd(),
): Promise<string> {
  try {
    // The inbox is umbrella-keyed (CAT.1c). Absent channels.json / unresolved
    // umbrella ⇒ no inbox; drain nothing.
    const cfg = await loadChannelsConfig().catch(() => null);
    const umbrellaId = cfg === null ? null : resolveUmbrellaForCwd(cfg, cwd);
    if (umbrellaId === null || umbrellaId === '') return '';

    const platformReads = await Promise.all(INBOX_PLATFORMS.map((p) => readInbox(umbrellaId, p)));
    const allRows = platformReads.flat();
    const acked = await readAcked(umbrellaId);
    const unacked = computeUnackedRows(allRows, acked, sessionId);

    let envelope = '';
    if (unacked.length > 0) {
      const built = buildInjectionEnvelope(unacked);
      if (built.injectedRows.length > 0) {
        envelope = built.envelope;
        const ackRows = buildAckRowsForInjected(built.injectedRows, sessionId);
        // ACK BEFORE RETURN — the durability + exactly-once gate.
        await appendAckRows(umbrellaId, ackRows);
      }
    }

    // 7-day auto-purge — skip the rewrite when nothing aged out.
    const kept = purgeOldAcks(acked);
    if (kept.length !== acked.length) {
      await rewriteAckedAfterPurge(umbrellaId, kept);
    }
    return envelope;
  } catch {
    return '';
  }
}
