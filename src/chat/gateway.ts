/**
 * Chat gateway — unified surface for bot-style chat connections (v0.7).
 *
 * Three concrete adapters plug into this interface: Telegram, Discord,
 * Slack. Each is independently activatable via a token in
 * `~/.opensquid/config.json` `chat_connections.<platform>.bot_token`.
 * Adapters that don't have a token configured are skipped at startup —
 * opensquid works fine with zero, one, or all three chat platforms wired.
 *
 * Scope decisions (per [[find-simple-solutions]]):
 * - Single bot owner per platform (no multi-tenancy, no OAuth flows).
 *   The user runs their OWN bot with their OWN token.
 * - Bot owner is the only authorized chat participant by default.
 *   Allowlist of additional chat/channel/user ids in config.
 * - Outbound-only connection mechanism (long-poll, WebSocket, Socket
 *   Mode) — no inbound HTTP server, no webhook URL, no public
 *   ingress required. Works behind any NAT.
 * - Text-only messages in v0.7. Images / files / inline buttons
 *   deferred until concrete user-need surfaces.
 *
 * Why a gateway abstraction at all (vs per-platform code paths):
 * the opensquid-side MCP tool surface (`chat.send`, `chat.list_channels`,
 * the inbound-message → MCP-context bridge) should NOT care which
 * platform a message came from. The gateway normalizes incoming events
 * to a single `ChatMessage` shape and routes outgoing sends by
 * channel id.
 *
 * What is NOT in this file:
 * - Token storage / config loading (lives in `chat/config.ts`).
 * - The actual SDK calls (live in `chat/adapters/<platform>.ts`).
 * - The MCP tool wiring (lives in `chat/mcp-tools.ts`).
 *
 * What IS in this file: types + the `ChatGateway` orchestrator that
 * holds N adapters and presents a single send/subscribe API.
 */

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------

/** Stable platform identifier. */
export type ChatPlatform = "telegram" | "discord" | "slack";

/**
 * A logical destination for outbound messages. The shape varies by
 * platform but always normalizes to a single string id from opensquid's
 * point of view. Adapters parse the id back to platform-native form
 * (Telegram chat_id, Discord channel snowflake, Slack channel id).
 *
 * Format: `<platform>:<native_id>`, e.g. `telegram:8075471258`.
 */
export type ChannelId = string;

/** Normalized inbound message (platform-agnostic shape). */
export interface ChatMessage {
  /** Stable id from the platform (snowflake / message_id / ts). */
  id: string;
  /** Which platform delivered this. */
  platform: ChatPlatform;
  /** Channel the message was posted in (DM, group, server channel). */
  channel: ChannelId;
  /** Display name of the sender (best-effort; falls back to user id). */
  sender: string;
  /** Native sender id (preserved for allowlist checks + replies). */
  senderId: string;
  /** Message body, text only in v0.7. */
  text: string;
  /** Wall-clock the platform stamped the message with. */
  receivedAt: Date;
  /** True when the message contains @-mention or trigger-word for the bot. */
  mentionsBot: boolean;
}

/**
 * Outbound message payload — text-only in v0.7. `replyTo` populates
 * platform-specific threading metadata where it's free (Telegram
 * `reply_to_message_id`, Slack `thread_ts`, Discord `message_reference`).
 */
export interface OutboundMessage {
  channel: ChannelId;
  text: string;
  /** Source message id to reply-thread under (best-effort per platform). */
  replyTo?: string;
}

/** Result of a single send. Adapter-defined fields preserved opaquely. */
export interface SendResult {
  platform: ChatPlatform;
  /** Native id of the delivered message — for future edit / delete / react. */
  messageId: string;
  /** Wall-clock the platform stamped the delivered message with. */
  deliveredAt: Date;
}

/** Inbound message handler. Async return for await-based pipelines. */
export type MessageHandler = (msg: ChatMessage) => Promise<void> | void;

// ---------------------------------------------------------------------
// Adapter contract
// ---------------------------------------------------------------------

/**
 * What every chat adapter must implement. Adapter authors hold the
 * platform-specific SDK / WebSocket / long-poll loop; this interface
 * is the only surface opensquid touches.
 *
 * Lifecycle:
 *   1. `start()` — open the connection (login, attach handlers).
 *      Resolves when ready to receive + send. Throws on auth failure.
 *   2. `onMessage(handler)` — subscribe to inbound events. Multiple
 *      subscriptions stack; all fire per message in registration order.
 *   3. `send(message)` — push outbound. Throws on permanent failures
 *      (channel doesn't exist, bot kicked); transient errors are
 *      retried internally per the adapter's policy.
 *   4. `shutdown()` — close the connection cleanly. Idempotent.
 *
 * `identity()` returns the bot's own user info (username + native id) —
 * used by the gateway to recognize self-authored messages and to
 * resolve @-mention tokens to bot identity.
 */
export interface ChatAdapter {
  /** Platform identifier this adapter handles. */
  readonly platform: ChatPlatform;

  start(): Promise<void>;
  shutdown(): Promise<void>;

  onMessage(handler: MessageHandler): void;
  send(message: OutboundMessage): Promise<SendResult>;

  identity(): Promise<{ username: string; nativeId: string }>;
}

// ---------------------------------------------------------------------
// Gateway orchestrator
// ---------------------------------------------------------------------

/**
 * Holds N adapters and presents the unified API. Construct with the
 * adapter array you want active for this opensquid process. Pre-wired
 * tokens live in config; the factory at `chat/factory.ts` builds the
 * adapter array based on which tokens are present.
 */
export class ChatGateway {
  private readonly adapters: Map<ChatPlatform, ChatAdapter>;
  private readonly handlers: MessageHandler[] = [];
  private started = false;

  constructor(adapters: ChatAdapter[]) {
    this.adapters = new Map(adapters.map((a) => [a.platform, a]));
  }

  /** Open all adapter connections in parallel. First failure surfaces. */
  async start(): Promise<void> {
    if (this.started) return;
    // Wire incoming handler dispatch BEFORE starting connections so we
    // don't drop early messages.
    for (const adapter of this.adapters.values()) {
      adapter.onMessage((msg) => this.dispatch(msg));
    }
    await Promise.all([...this.adapters.values()].map((a) => a.start()));
    this.started = true;
  }

  /** Close all adapter connections. Errors are logged and swallowed
   * so shutdown is always best-effort. */
  async shutdown(): Promise<void> {
    if (!this.started) return;
    await Promise.allSettled([...this.adapters.values()].map((a) => a.shutdown()));
    this.started = false;
  }

  /** Subscribe to inbound messages from any platform. */
  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  /** Route an outbound message to the right adapter by `channel` prefix. */
  async send(message: OutboundMessage): Promise<SendResult> {
    const platform = platformFromChannel(message.channel);
    const adapter = this.adapters.get(platform);
    if (!adapter) {
      throw new ChatGatewayError(
        `no adapter active for platform '${platform}' (channel '${message.channel}')`,
        "ensure the corresponding bot_token is set in ~/.opensquid/config.json chat_connections",
      );
    }
    return adapter.send(message);
  }

  /** List the platforms currently wired up. Used by `chat.list_channels`. */
  activePlatforms(): ChatPlatform[] {
    return [...this.adapters.keys()];
  }

  private async dispatch(msg: ChatMessage): Promise<void> {
    for (const handler of this.handlers) {
      try {
        await handler(msg);
      } catch (err) {
        const e = err instanceof Error ? err.message : String(err);
        // Don't let one handler break the dispatch chain.
        // eslint-disable-next-line no-console
        console.error(`[chat-gateway] handler error on ${msg.platform}: ${e}`);
      }
    }
  }
}

// ---------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------

export class ChatGatewayError extends Error {
  constructor(
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "ChatGatewayError";
  }
}

// ---------------------------------------------------------------------
// ChannelId helpers
// ---------------------------------------------------------------------

export function formatChannelId(platform: ChatPlatform, nativeId: string): ChannelId {
  return `${platform}:${nativeId}`;
}

export function platformFromChannel(channel: ChannelId): ChatPlatform {
  const idx = channel.indexOf(":");
  if (idx === -1) {
    throw new ChatGatewayError(
      `malformed channel id '${channel}'`,
      "channel ids must be '<platform>:<native_id>', e.g. 'telegram:8075471258'",
    );
  }
  const candidate = channel.slice(0, idx);
  if (candidate !== "telegram" && candidate !== "discord" && candidate !== "slack") {
    throw new ChatGatewayError(
      `unknown platform '${candidate}' in channel id '${channel}'`,
      "supported platforms: telegram, discord, slack",
    );
  }
  return candidate;
}

export function nativeIdFromChannel(channel: ChannelId): string {
  const idx = channel.indexOf(":");
  if (idx === -1) {
    throw new ChatGatewayError(`malformed channel id '${channel}'`);
  }
  return channel.slice(idx + 1);
}
