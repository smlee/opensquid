/**
 * agent_bridge — shared types (WAB.2, 0.5.94).
 *
 * Authoritative source: `docs/tasks/WAB.1-architecture.md` decisions (b) +
 * (c), and `docs/tasks/T-warm-agent-chat-bridge.md` WAB.2 spec.
 *
 * Why one types module: all six WAB sub-modules (event_bus, transport_bridge,
 * session_manager, agent_loop, batch, dispatcher) share the SessionKey +
 * InboundChatEvent + OutboundChatReply contracts. Inlining them per-module
 * would either duplicate the zod schemas (drift risk) or chain imports
 * deeply (re-export thrash). One types module + barrel re-export keeps
 * the public surface flat for consumers.
 *
 * Schema validation discipline: every type that crosses an external
 * boundary (chokidar-watched JSONL file, MCP tool args, future RPC) has a
 * zod schema declared next to its TS interface; the schema is the runtime
 * gate and the TS type is `z.infer<typeof schema>`. This matches the
 * pattern in `src/runtime/types.ts`.
 *
 * Imports from: zod.
 * Imported by: event_bus.ts, transport_bridge.ts, (future) session_manager,
 *   agent_loop, batch, dispatcher.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// SessionKey — `(platform, chatId, threadId?)` triple.
//
// Mirrors Hermes `build_session_key` (`gateway/platforms/base.py:2762`) and
// the legacy `InboxMessage.thread_id` field (`src.legacy/chat/daemon/inbox.ts`).
// Telegram supergroup ids are negative integers; DM user ids are positive;
// both stringify safely. Discord + Slack reserved for future adapters.
// ---------------------------------------------------------------------------

export const SessionPlatform = z.enum(['telegram', 'discord', 'slack']);
export type SessionPlatform = z.infer<typeof SessionPlatform>;

export const sessionKeySchema = z.object({
  platform: SessionPlatform,
  chatId: z.string().min(1),
  threadId: z.string().optional(),
});
export type SessionKey = z.infer<typeof sessionKeySchema>;

/**
 * Canonical slug form. `<platform>:<chatId>[:<threadId>]`.
 *
 * Used as the LRU cache key (WAB.3) and as the on-disk filename base for
 * persisted session history. Hex-encoded by the persistence layer before
 * touching the filesystem; this function is the pre-encoding form.
 */
export function sessionKeyString(k: SessionKey): string {
  return k.threadId !== undefined
    ? `${k.platform}:${k.chatId}:${k.threadId}`
    : `${k.platform}:${k.chatId}`;
}

// ---------------------------------------------------------------------------
// InboundChatEvent — emitted by transport_bridge when a JSONL row lands.
//
// Field mapping from legacy `InboxMessage` (snake_case, written by the
// chat-daemon's `appendToInbox` at `src.legacy/chat/daemon/inbox.ts`) →
// modern camelCase. The mapping happens at the bridge boundary so the rest
// of the warm-agent code sees a clean Phase-1 shape.
//
// `projectUuid` is carried explicitly because the transport_bridge is
// per-project (one instance per `~/.opensquid/projects/<uuid>/inbox/`),
// and the downstream session manager + agent loop need it for tool calls
// that resolve back to project-scoped resources (RAG scope, channel
// routing, etc.).
//
// `raw` preserves the original JSONL payload for callers that want
// platform-specific fields (mentions_bot, etc.) without expanding the
// typed surface.
// ---------------------------------------------------------------------------

export const inboundChatEventSchema = z.object({
  kind: z.literal('inbound_message'),
  sessionKey: sessionKeySchema,
  messageId: z.string().min(1),
  sender: z.object({
    id: z.string().min(1),
    name: z.string().optional(),
  }),
  text: z.string(),
  receivedAt: z.string().datetime({ offset: true }),
  enqueuedAt: z.string().datetime({ offset: true }),
  projectUuid: z.string().uuid(),
  raw: z.record(z.unknown()).optional(),
});
export type InboundChatEvent = z.infer<typeof inboundChatEventSchema>;

// ---------------------------------------------------------------------------
// OutboundChatReply — agent's reply payload before it hits the legacy RPC.
//
// Used by future WAB.6 chat_send tool wrapper. Declared here to keep the
// agent_bridge public surface in one place; transport_bridge does not emit
// these (outbound goes via RPC, not file-watcher).
// ---------------------------------------------------------------------------

export const outboundChatReplySchema = z.object({
  sessionKey: sessionKeySchema,
  text: z.string().min(1),
  /** Optional source message id to thread under (Telegram reply_to_message_id). */
  replyTo: z.string().optional(),
  projectUuid: z.string().uuid(),
});
export type OutboundChatReply = z.infer<typeof outboundChatReplySchema>;
