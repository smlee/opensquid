/**
 * Channel adapter interface — transport-agnostic.
 *
 * Adapters are keyed by URI scheme (chat://, telegram://, discord://, ...)
 * and the notification router (Task 1.14) dispatches by scheme. Nothing
 * here may leak transport-specific shape (no bot tokens, webhook URLs,
 * markdown flavors, etc.) — those live in each adapter's own module.
 */

import type { InboundChannelEvent } from '../runtime/event.js';

export type Severity = 'critical' | 'error' | 'warning' | 'info';

export interface ChannelMessage {
  text: string;
  severity?: Severity;
}

export interface SendResult {
  ok: boolean;
  error?: string;
}

/**
 * Returned by `subscribeInbound`. Calling `unsubscribe()` detaches the
 * handler from the underlying SDK client; the client itself stays alive
 * for outbound `send()` callers. After unsubscribe resolves, no further
 * events for this subscription will fire.
 */
export interface InboundSubscription {
  unsubscribe(): Promise<void>;
}

/**
 * CAT.1b — the RICH inbound transport envelope. Where `InboundChannelEvent`
 * (AUTO.6) is a lossy projection for pack-event dispatch, this carries every
 * field the chat-daemon needs to (a) write a byte-compatible inbox JSONL row
 * (`src/runtime/chat/inbox.ts InboxRow`) and (b) route by the umbrella FSM
 * (`src/channels/routing.ts`): the message id, separate sender display vs id,
 * the DM flag, and the raw chat/topic ids. The adapter builds this once per
 * inbound message; the lossy `InboundChannelEvent` is derived from it.
 */
export interface InboundChatMessage {
  platform: 'telegram' | 'discord' | 'slack';
  /** Platform message id (→ InboxRow.id + ack dedup). */
  messageId: string;
  /** Native chat/supergroup id as a string (→ routing + InboxRow.channel). */
  chatId: string;
  /** Forum-topic / thread id, when present (→ routing + InboxRow.thread_id). */
  topicId?: number;
  /** Display name of the sender (best-effort, falls back to id). */
  sender: string;
  /** Native sender id (→ DM routing + InboxRow.sender_id). */
  senderId: string;
  /** Message text (empty string when the message carried no text). */
  text: string;
  /** ISO-8601 wall-clock the platform stamped (→ InboxRow.received_at). */
  receivedAt: string;
  /** True iff the message @-mentions / triggers the bot (→ InboxRow.mentions_bot). */
  mentionsBot: boolean;
  /** True iff a private chat (Telegram: chat.id === from.id) → DM routing. */
  direct: boolean;
}

/**
 * AUTO.6 — inbound surface. Each platform-specific adapter that can
 * accept incoming messages (Telegram bot updates, Discord guild messages,
 * Slack Socket Mode events) implements this method. Adapters that are
 * fundamentally outbound-only (webhook://) omit it; the `InboundRouter`
 * checks for presence before calling.
 *
 * Contract:
 *   - `handler` is invoked once per inbound message after the adapter
 *     maps platform-specific payload → unified `InboundChannelEvent`.
 *   - The adapter is responsible for any platform-specific ack SLA
 *     (Slack's 3s) — it MUST ack BEFORE invoking `handler` so handler
 *     latency cannot violate the SLA.
 *   - `handler` errors are caught and swallowed by the adapter — never
 *     bubble out to the platform-side event loop.
 *   - `unsubscribe()` is idempotent + safe to call before the adapter's
 *     client has finished starting.
 */
export interface ChannelAdapter {
  /** URI scheme this adapter handles, e.g. 'chat', 'telegram'. */
  scheme: string;
  /** True iff this adapter can deliver to the given URI. */
  validate(uri: string): boolean;
  /** Deliver the message; never throws — failure is surfaced via SendResult. */
  send(uri: string, message: ChannelMessage): Promise<SendResult>;
  /**
   * Optional inbound surface (AUTO.6). Adapters that emit
   * `InboundChannelEvent` (telegram/discord/slack) implement this;
   * outbound-only adapters (webhook) omit it.
   */
  subscribeInbound?(
    handler: (event: InboundChannelEvent) => Promise<void>,
  ): Promise<InboundSubscription>;
  /**
   * Optional RICH inbound surface (CAT.1b) for the chat-transport daemon.
   * Emits the full `InboundChatMessage` envelope. Adapters that back a
   * remote-terminal transport (telegram first) implement it; outbound-only
   * adapters omit it. Same ack-before-handler + swallow-errors contract as
   * `subscribeInbound`.
   */
  subscribeTransport?(
    handler: (msg: InboundChatMessage) => Promise<void>,
  ): Promise<InboundSubscription>;
}

/**
 * Notification routing configuration — declared by the pack, mapped to
 * concrete URIs by the user's runtime config.
 *
 * - `severityTiers`: per-severity list of abstract channel names (e.g.
 *   `['alerts', 'audit_log']`) that the pack wants notified.
 * - `perProjectOverride`: optional per-project override keyed by project
 *   id, layered on top of severity tiers. Checked first when present.
 * - `channelMapping`: abstract-name → concrete-URI mapping the user
 *   provides (e.g. `alerts` → `telegram://chat_id/topic_id`). The router
 *   special-cases the abstract name `'chat'` to `chat://`, so it does
 *   not need an explicit entry here.
 */
export interface RoutingConfig {
  severityTiers: Record<Severity, string[]>;
  perProjectOverride?: Record<string, Record<Severity, string[]>>;
  channelMapping: Record<string, string>;
}
