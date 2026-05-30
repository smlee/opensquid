/**
 * Inbox row + ack row schemas for the L3 communication loop (T-L3-LOOP LL.1).
 *
 * The chat-daemon writes one inbound message per line to
 * `~/.opensquid/projects/<projectUuid>/inbox/<platform>.jsonl` (the on-disk
 * contract documented at `src/runtime/paths.ts:253-260`). Until LL.1 this
 * shape was implicit — declared inline in `src/mcp/chat-bridge-server.ts`
 * as `interface InboxMessage`. LL.1 lifts it to a single Zod source-of-truth
 * so the MCP tool, the chokidar tail watcher (LL.3), and the UPS hook (LL.4)
 * all bind to the same parser.
 *
 * `AckRow` is the LL.4-locked ack ledger row: append-only to
 * `~/.opensquid/projects/<projectUuid>/inbox/acked.jsonl`. The (platform,
 * message_id, injected_at_sessionId) triple is the dedup key per L2 of the
 * T-L3-LOOP locked decisions.
 *
 * `v: z.literal(1)` is a forward-compat envelope marker — when the daemon
 * eventually bumps the format, both readers + writer migrate atomically.
 * AckRow.safeParse on a v:2 row returns failure → row treated as "not acked"
 * → duplicate injection. LL.4 documents the mitigation in its dedup loop.
 *
 * `readInbox` + `readAcked` are best-effort: malformed lines are silently
 * skipped (the daemon writes valid JSON per row but a partial write at the
 * tail is possible during rotation). LL.5 documents the silent-skip behavior.
 *
 * Imports from: zod, node:fs/promises, ../paths.
 * Imported by: src/mcp/chat-bridge-server.ts (read tool); LL.3 inbound_watch.ts
 *   (chokidar tail); LL.4 user-prompt-submit.ts (inject + ack); tests.
 */

import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import { inboxAckedPath, inboxFile } from '../paths.js';

// ---------------------------------------------------------------------------
// Platform enum — opensquid currently bridges Telegram + Slack + Discord
// per chat-bridge-server's existing channel typing. Extending requires
// updating the chat-daemon writer + every consumer; keep the closed list.
// ---------------------------------------------------------------------------

export const Platform = z.enum(['telegram', 'discord', 'slack']);
export type Platform = z.infer<typeof Platform>;

// ---------------------------------------------------------------------------
// InboxRow — the chat-daemon's on-disk inbound message envelope.
//
// Field set MUST stay byte-for-byte compatible with the inline shape at
// `src/mcp/chat-bridge-server.ts:InboxMessage` (refactor target) so existing
// daemon writes parse unchanged. Note `id` (not `message_id`) — matches the
// daemon writer; AckRow uses `message_id` (clearer in ack context per L13;
// the asymmetry is intentional).
// ---------------------------------------------------------------------------

export const InboxRow = z
  .object({
    v: z.literal(1),
    id: z.string().min(1),
    thread_id: z.string().optional(),
    platform: Platform,
    channel: z.string(),
    sender: z.string(),
    sender_id: z.string(),
    text: z.string(),
    received_at: z.string(),
    enqueued_at: z.string(),
    mentions_bot: z.boolean(),
  })
  .strict();
export type InboxRow = z.infer<typeof InboxRow>;

// ---------------------------------------------------------------------------
// AckRow — LL.4 ack ledger row. Append-only; never edited or deleted.
// Dedup key = `${platform}::${message_id}::${sessionId}`.
//
// `message_id` (not `id`) — intentional asymmetry from InboxRow; ack context
// is clearer when the field reads as a foreign key.
// ---------------------------------------------------------------------------

export const AckRow = z
  .object({
    v: z.literal(1),
    message_id: z.string().min(1),
    platform: Platform,
    injected_at_sessionId: z.string().min(1),
    injected_at_timestamp: z.string(),
  })
  .strict();
export type AckRow = z.infer<typeof AckRow>;

/**
 * Read every InboxRow from a project's per-platform inbox file. Malformed
 * lines are silently skipped — the daemon writes valid JSON per row but a
 * partial write at the tail is possible during rotation. ENOENT → empty.
 */
export async function readInbox(projectUuid: string, platform: Platform): Promise<InboxRow[]> {
  let raw: string;
  try {
    raw = await readFile(inboxFile(projectUuid, platform), 'utf8');
  } catch {
    return [];
  }
  const out: InboxRow[] = [];
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const safe = InboxRow.safeParse(parsed);
    if (safe.success) out.push(safe.data);
  }
  return out;
}

/**
 * Read every AckRow for a project. Used by LL.4 UPS hook to build the
 * dedup set before deciding which inbox rows to inject. Same silent-skip
 * semantics as `readInbox`.
 */
export async function readAcked(projectUuid: string): Promise<AckRow[]> {
  let raw: string;
  try {
    raw = await readFile(inboxAckedPath(projectUuid), 'utf8');
  } catch {
    return [];
  }
  const out: AckRow[] = [];
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const safe = AckRow.safeParse(parsed);
    if (safe.success) out.push(safe.data);
  }
  return out;
}

/** Build the canonical dedup-key string used by the inject/ack loop. */
export function ackKey(platform: Platform, messageId: string, sessionId: string): string {
  return `${platform}::${messageId}::${sessionId}`;
}
