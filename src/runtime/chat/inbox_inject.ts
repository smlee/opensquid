/**
 * Pure helpers for the UPS hook's inbox-drain step (T-L3-LOOP LL.4).
 *
 * Split off from `user-prompt-submit.ts` so the inject logic is unit-testable
 * without spawning the hook binary. The hook calls these helpers in sequence:
 *   1. readInbox + readAcked (LL.1)
 *   2. computeUnackedRows (this module)
 *   3. buildInjectionEnvelope (this module) → appended to additionalContext
 *   4. appendAckRows (inbox_writer.ts, durable)
 *   5. purgeOldAcks + rewriteAckedAfterPurge (inbox_writer.ts, conditional)
 *
 * Per L6 of T-L3-LOOP locked decisions: multi-message aggregation happens
 * IN-HOOK (one envelope per UPS fire; one AckRow per included message).
 * Per L7 ("lazy push"): the LL.3 watcher already fired the inbound_channel
 * dispatch event; THIS module is the additionalContext injection — the
 * agent-facing surface that survives orphaned-watcher gaps.
 *
 * ACK-BEFORE-EMIT ordering (per L5): the hook MUST append AckRows BEFORE
 * printing the envelope to stdout. If the hook crashes between emit + ack,
 * the next fire re-injects (duplicate-in-conversation). If we acked first
 * then crashed before emit, the user would never see the message (silent
 * loss). Duplicate-on-rare-crash beats silent loss.
 */
import { ackKey, type AckRow, type InboxRow } from './inbox.js';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const ENVELOPE_BUDGET_BYTES = 8 * 1024;

/**
 * Filter inbox rows to those NOT yet acked. Dedup key is
 * `(platform, message_id)` per LL4FIX.1 (2026-05-31). Was previously
 * keyed with sessionId — that re-flooded every new session with the
 * entire backlog because no prior-session ack matched. The fix drops
 * sessionId from the SET-key derivation; the arg stays on this fn
 * signature because `buildAckRowsForInjected` still records
 * `injected_at_sessionId` as audit metadata + drives 7-day purge.
 */
export function computeUnackedRows(
  rows: readonly InboxRow[],
  acked: readonly AckRow[],
  sessionId: string,
): InboxRow[] {
  const ackedKeys = new Set<string>();
  for (const a of acked) {
    ackedKeys.add(ackKey(a.platform, a.message_id));
  }
  const unacked: InboxRow[] = [];
  for (const row of rows) {
    const key = ackKey(row.platform, row.id);
    if (ackedKeys.has(key)) continue;
    unacked.push(row);
  }
  // sessionId is intentionally unused inside the dedup loop — see fn-level
  // JSDoc. Linters might flag it; suppress at the call site if needed.
  void sessionId;
  unacked.sort((a, b) => a.received_at.localeCompare(b.received_at));
  return unacked;
}

/**
 * Build the additionalContext envelope per L6. Format is human-scannable +
 * future-parser-friendly: a 📨 header line + per-row `<sender> (<platform>):
 * <text>` lines.
 *
 * Returns an empty envelope + zero injectedRows if `rows` is empty.
 * Overflow handling: if cumulative text would exceed
 * ENVELOPE_BUDGET_BYTES (8KB), the loop stops at the row that wouldn't
 * fit; remaining rows are NOT injected this turn and stay unacked
 * (drain on next UPS fire — preserves "lazy push" semantics).
 *
 * `injectedRows` is what the hook should pass to `buildAckRowsForInjected`
 * — only acked rows that actually made it into the envelope.
 */
export function buildInjectionEnvelope(rows: readonly InboxRow[]): {
  envelope: string;
  injectedRows: InboxRow[];
} {
  if (rows.length === 0) return { envelope: '', injectedRows: [] };
  const lines: string[] = [];
  const injected: InboxRow[] = [];
  let bytes = 0;
  for (const row of rows) {
    const line = `${row.sender} (${row.platform}): ${row.text}`;
    const projected = bytes + line.length + 1;
    if (projected > ENVELOPE_BUDGET_BYTES && injected.length > 0) {
      break;
    }
    lines.push(line);
    injected.push(row);
    bytes = projected;
  }
  const header = `📨 Inbound messages (${String(injected.length)})`;
  const envelope = `${header}\n${lines.join('\n')}`;
  return { envelope, injectedRows: injected };
}

/**
 * Filter AckRows to those younger than 7 days. Used by the periodic purge
 * step to keep acked.jsonl from growing unbounded. Malformed timestamps
 * are dropped (defensive — schema validation upstream is best-effort).
 */
export function purgeOldAcks(acked: readonly AckRow[], now: Date = new Date()): AckRow[] {
  const cutoff = now.getTime() - SEVEN_DAYS_MS;
  return acked.filter((a) => {
    const t = Date.parse(a.injected_at_timestamp);
    return Number.isFinite(t) && t >= cutoff;
  });
}

/**
 * Build AckRows from injected InboxRows, stamped with the current sessionId
 * + now. Hook passes the result to `appendAckRows` (inbox_writer.ts).
 */
export function buildAckRowsForInjected(
  injected: readonly InboxRow[],
  sessionId: string,
  now: Date = new Date(),
): AckRow[] {
  const ts = now.toISOString();
  return injected.map((row) => ({
    v: 1 as const,
    message_id: row.id,
    platform: row.platform,
    injected_at_sessionId: sessionId,
    injected_at_timestamp: ts,
  }));
}
