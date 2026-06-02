/**
 * Transport inbound → umbrella inbox writer (CAT.1b).
 *
 * The chat-daemon subscribes the telegram adapter's rich transport surface
 * (`subscribeTransport`) and hands each `InboundChatMessage` here. This module:
 *
 *   1. resolves the message to an umbrella (or `general`, or orphan) via the
 *      pure FSM in `./routing.ts` — the deterministic replacement for the
 *      legacy in-worker `RoutingIndex` Map; and
 *   2. appends a byte-for-byte-compatible inbox row to that umbrella's
 *      `umbrellas/<id>/inbox/<platform>.jsonl` (orphan → the legacy top-level
 *      `inbox/orphan/<platform>.jsonl`).
 *
 * The row shape is IDENTICAL to what the live legacy daemon writes + what
 * `src/runtime/chat/inbox.ts InboxRow` parses (verified against live bytes):
 *   { v:1, id, thread_id?, platform, channel:"<platform>:<chatId>", sender,
 *     sender_id, text, received_at, enqueued_at, mentions_bot }
 * Only the directory KEY changes (project_uuid → umbrella). Readers move to the
 * umbrella key in CAT.1c.
 *
 * Append is O_APPEND atomic per line (matches the legacy `appendToInbox`); the
 * row is pre-serialized so a partial write can only ever truncate a tail line,
 * which every reader silent-skips.
 *
 * Imports from: node:fs/promises, node:path, ../runtime/paths, ./routing,
 *   ./types. Imported by: the CAT.1b daemon + tests.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { orphanInboxFile, umbrellaInboxFile } from '../runtime/paths.js';

import { resolveInboundUmbrella, type ChannelsConfig } from './routing.js';
import type { InboundChatMessage } from './types.js';

/** The byte-compatible inbox row (kept in field order matching live bytes). */
interface InboxLine {
  v: 1;
  id: string;
  thread_id?: string;
  platform: string;
  channel: string;
  sender: string;
  sender_id: string;
  text: string;
  received_at: string;
  enqueued_at: string;
  mentions_bot: boolean;
}

/**
 * Project a rich `InboundChatMessage` to the on-disk inbox row. `channel` is
 * `"<platform>:<chatId>"` (legacy `formatChannelId` shape, e.g.
 * `telegram:-1003923174632`); `enqueuedAtIso` is stamped by the daemon at
 * write time.
 */
export function buildInboxLine(msg: InboundChatMessage, enqueuedAtIso: string): InboxLine {
  return {
    v: 1,
    id: msg.messageId,
    ...(msg.topicId !== undefined ? { thread_id: String(msg.topicId) } : {}),
    platform: msg.platform,
    channel: `${msg.platform}:${msg.chatId}`,
    sender: msg.sender,
    sender_id: msg.senderId,
    text: msg.text,
    received_at: msg.receivedAt,
    enqueued_at: enqueuedAtIso,
    mentions_bot: msg.mentionsBot,
  };
}

export interface RouteWriteResult {
  destination: 'umbrella' | 'orphan';
  /** Set when destination === 'umbrella' (the umbrella id or `general`). */
  umbrellaId?: string;
  /** Absolute path the row was appended to. */
  inboxPath: string;
}

/** Append a pre-built row as one JSONL line; create the parent dir on demand. */
async function appendLine(path: string, line: InboxLine): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(line) + '\n', 'utf8');
}

/**
 * Resolve `msg` to its umbrella via the FSM and append the inbox row. Telegram
 * only for now (the rich envelope is telegram-sourced); other platforms route
 * to orphan until their adapters emit `InboundChatMessage`. Returns where the
 * row landed.
 */
export async function routeAndWriteInbound(
  cfg: ChannelsConfig,
  msg: InboundChatMessage,
  enqueuedAtIso: string,
): Promise<RouteWriteResult> {
  const target =
    msg.platform === 'telegram'
      ? resolveInboundUmbrella(cfg, {
          platform: 'telegram',
          chatId: msg.chatId,
          ...(msg.topicId !== undefined ? { topicId: msg.topicId } : {}),
          senderId: msg.senderId,
          direct: msg.direct,
        })
      : null;

  const line = buildInboxLine(msg, enqueuedAtIso);

  if (target === null) {
    const path = orphanInboxFile(msg.platform);
    await appendLine(path, line);
    return { destination: 'orphan', inboxPath: path };
  }

  const path = umbrellaInboxFile(target, msg.platform);
  await appendLine(path, line);
  return { destination: 'umbrella', umbrellaId: target, inboxPath: path };
}
