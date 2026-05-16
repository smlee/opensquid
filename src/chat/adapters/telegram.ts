/**
 * Telegram adapter — long-polling via the official Bot API (v0.7a).
 *
 * SDK: `grammy` (modern, TS-first, actively maintained — recommended
 * over `telegraf` which is frozen at v4.16 from Feb 2024 and over
 * `node-telegram-bot-api` which is untyped).
 *
 * Connection: long-polling via `bot.start()` — no public webhook URL
 * required. The bot opens an outbound HTTPS connection to
 * `api.telegram.org` and polls for updates. Works behind any NAT.
 *
 * Why `grammy` is loaded via dynamic import: opensquid declares all
 * three chat SDKs as optionalDependencies. Users with no Telegram
 * config (and possibly `npm --omit=optional`) shouldn't pay the install
 * cost. The dynamic import only runs in `start()` when this adapter
 * is actually being activated — and produces a clear "install grammy"
 * error if the dep is missing.
 *
 * Gotcha: only ONE polling consumer per token at a time. A second
 * opensquid process with the same token will collide with 409 Conflict.
 * Surface that error clearly on start.
 */

import {
  type ChatAdapter,
  ChatGatewayError,
  type ChatMessage,
  type MessageHandler,
  type OutboundMessage,
  type SendResult,
  formatChannelId,
} from "../gateway.js";
import type { TelegramConfig } from "../config.js";

// grammy's TS types — declared as `unknown` to avoid hard-importing the
// SDK at compile time (we want it as an optionalDependency, not a
// build-time peer). Adapter narrows via runtime checks when the dynamic
// import resolves.
interface GrammyBotApi {
  sendMessage(
    chat_id: string | number,
    text: string,
    other?: { reply_to_message_id?: number; message_thread_id?: number },
  ): Promise<{ message_id: number; date: number }>;
  getMe(): Promise<{ id: number; username?: string; first_name?: string; is_bot: boolean }>;
  /** v0.7.2 — forum-topic creation (supergroup with Topics enabled + Manage Topics admin right). */
  createForumTopic(
    chat_id: string | number,
    name: string,
    other?: { icon_color?: number; icon_custom_emoji_id?: string },
  ): Promise<{ message_thread_id: number; name: string; icon_color: number }>;
}

interface GrammyContext {
  message?: {
    message_id: number;
    /** Forum topic thread id when the message arrived in a topic (v0.7.2). */
    message_thread_id?: number;
    text?: string;
    chat: { id: number; type: string };
    from?: { id: number; username?: string; first_name?: string };
    date: number;
    entities?: Array<{ type: string; offset: number; length: number }>;
  };
}

interface GrammyBot {
  api: GrammyBotApi;
  on(event: "message", handler: (ctx: GrammyContext) => Promise<void> | void): void;
  start(opts?: { onStart?: () => void }): Promise<void>;
  stop(): Promise<void>;
  botInfo?: { id: number; username: string };
}

export class TelegramAdapter implements ChatAdapter {
  readonly platform = "telegram" as const;

  private bot: GrammyBot | null = null;
  private handlers: MessageHandler[] = [];
  private botUsername = "";
  private botId = "";
  private startPromise: Promise<void> | null = null;

  constructor(private readonly config: TelegramConfig) {
    if (!config.bot_token?.trim()) {
      throw new ChatGatewayError(
        "telegram adapter: bot_token is required",
        "set chat_connections.telegram.bot_token in ~/.opensquid/config.json",
      );
    }
  }

  async start(): Promise<void> {
    if (this.bot) return;
    let Bot: new (token: string) => GrammyBot;
    try {
      const grammy = (await import("grammy")) as unknown as {
        Bot: new (token: string) => GrammyBot;
      };
      Bot = grammy.Bot;
    } catch (err) {
      // v0.7 audit fix (M5): distinguish "not installed" from "installed
      // but threw on load" — different remediation each case.
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
        throw new ChatGatewayError(
          "telegram adapter: 'grammy' SDK not installed",
          "run `npm install grammy` (or reinstall opensquid without --omit=optional)",
        );
      }
      throw new ChatGatewayError(
        `telegram adapter: 'grammy' SDK failed to load: ${err instanceof Error ? err.message : String(err)}`,
        "the SDK is installed but threw on import — check node version compatibility",
      );
    }

    const bot = new Bot(this.config.bot_token);
    this.bot = bot;

    // Probe identity + token validity. Throws on bad token.
    const me = await bot.api.getMe();
    this.botUsername = me.username ?? "";
    this.botId = String(me.id);

    bot.on("message", async (ctx) => {
      const m = ctx.message;
      if (!m?.text) return; // ignore non-text in v0.7
      const chatIdStr = String(m.chat.id);
      // Allowlist enforcement.
      if (
        this.config.allowlist_chat_ids &&
        this.config.allowlist_chat_ids.length > 0 &&
        !this.config.allowlist_chat_ids.includes(chatIdStr)
      ) {
        return; // silently drop — bot must not echo policy decisions
      }
      const normalized: ChatMessage = {
        id: String(m.message_id),
        threadId: m.message_thread_id !== undefined ? String(m.message_thread_id) : undefined,
        platform: "telegram",
        channel: formatChannelId("telegram", chatIdStr),
        sender: m.from?.username ?? m.from?.first_name ?? String(m.from?.id ?? "unknown"),
        senderId: String(m.from?.id ?? ""),
        text: m.text,
        receivedAt: new Date(m.date * 1000),
        mentionsBot: detectBotMention(m.text, m.entities, this.botUsername),
      };
      for (const h of this.handlers) {
        try {
          await h(normalized);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // eslint-disable-next-line no-console
          console.error(`[telegram adapter] handler error: ${msg}`);
        }
      }
    });

    // `bot.start()` resolves only on bot.stop(). Fire-and-track via a
    // promise we keep around for shutdown, but don't await it here.
    // v0.7 audit fix (H1): the 409 Conflict from a second polling
    // consumer surfaces as a rejection on this promise AFTER start()
    // has already resolved. Attach a catch so the rejection is observed
    // and surfaced; we tear down the adapter and clear bot so callers
    // get a useful error on next send() instead of silent dead-bot.
    this.startPromise = bot.start().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      const is409 = /409|Conflict/.test(msg);
      // eslint-disable-next-line no-console
      console.error(
        `[telegram adapter] long-poll loop ${is409 ? "lost: 409 Conflict — another polling consumer holds this token" : "errored"}: ${msg}`,
      );
      this.bot = null;
      this.startPromise = null;
    });
    // Yield once so the polling loop has a tick to register before the
    // gateway moves on to dispatch outbound messages.
    await new Promise((r) => setImmediate(r));
  }

  async shutdown(): Promise<void> {
    if (!this.bot) return;
    try {
      await this.bot.stop();
    } catch {
      // best-effort — if grammy already torn down, nothing to do
    }
    if (this.startPromise) {
      // bot.start()'s promise should resolve after stop. Don't hang
      // forever though — race against a short timeout.
      await Promise.race([this.startPromise, new Promise((r) => setTimeout(r, 2000))]);
    }
    this.bot = null;
    this.startPromise = null;
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    if (!this.bot) {
      throw new ChatGatewayError(
        "telegram adapter: not started",
        "call gateway.start() before send()",
      );
    }
    const chatId = nativeChatIdFromChannel(message.channel);
    const opts: { reply_to_message_id?: number; message_thread_id?: number } = {};
    if (message.replyTo) {
      const n = Number(message.replyTo);
      if (Number.isFinite(n)) opts.reply_to_message_id = n;
    }
    if (message.threadId) {
      const n = Number(message.threadId);
      if (Number.isFinite(n)) opts.message_thread_id = n;
    }
    const sent = await this.bot.api.sendMessage(chatId, message.text, opts);
    return {
      platform: "telegram",
      messageId: String(sent.message_id),
      deliveredAt: new Date(sent.date * 1000),
    };
  }

  /**
   * v0.7.2 — Create a forum topic in a supergroup. Requires the bot
   * to be admin with "Manage Topics" permission and the supergroup to
   * have Topics enabled in settings. Returns the topic's
   * `message_thread_id` for storage in chat-routing.json.
   */
  async createTopic(
    chatId: string,
    name: string,
    options: { iconColor?: number; iconCustomEmojiId?: string } = {},
  ): Promise<{ message_thread_id: number; name: string }> {
    if (!this.bot) {
      throw new ChatGatewayError(
        "telegram adapter: not started",
        "call gateway.start() before createTopic()",
      );
    }
    const apiOpts: { icon_color?: number; icon_custom_emoji_id?: string } = {};
    if (options.iconColor !== undefined) apiOpts.icon_color = options.iconColor;
    if (options.iconCustomEmojiId !== undefined)
      apiOpts.icon_custom_emoji_id = options.iconCustomEmojiId;
    const res = await this.bot.api.createForumTopic(chatId, name, apiOpts);
    return { message_thread_id: res.message_thread_id, name: res.name };
  }

  async identity(): Promise<{ username: string; nativeId: string }> {
    if (!this.bot) {
      throw new ChatGatewayError("telegram adapter: not started");
    }
    return { username: this.botUsername, nativeId: this.botId };
  }
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function nativeChatIdFromChannel(channel: string): string {
  // formatChannelId is "telegram:<id>" — strip the prefix.
  const idx = channel.indexOf(":");
  if (idx === -1) {
    throw new ChatGatewayError(`malformed channel id '${channel}'`);
  }
  if (channel.slice(0, idx) !== "telegram") {
    throw new ChatGatewayError(`telegram adapter received non-telegram channel: '${channel}'`);
  }
  return channel.slice(idx + 1);
}

/**
 * Detect whether a message text contains an @-mention of this bot, or
 * uses one of telegram's bot_command entities pointing at the bot
 * (`/cmd@my_bot`).
 *
 * Exported for unit testing.
 */
export function detectBotMention(
  text: string,
  entities: Array<{ type: string; offset: number; length: number }> | undefined,
  botUsername: string,
): boolean {
  if (!botUsername) return false;
  const lower = `@${botUsername.toLowerCase()}`;
  if (text.toLowerCase().includes(lower)) return true;
  if (!entities) return false;
  for (const ent of entities) {
    if (ent.type !== "mention" && ent.type !== "bot_command") continue;
    const slice = text.slice(ent.offset, ent.offset + ent.length).toLowerCase();
    if (slice.includes(lower)) return true;
  }
  return false;
}
