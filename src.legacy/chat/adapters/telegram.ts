/**
 * Telegram adapter — long-polling via the official Bot API (v0.7a).
 *
 * Rebuild path when you edit this file: `pnpm build` does NOT recompile
 * src.legacy/ (rootDir=src per tsconfig.build.json), but the chat-daemon
 * worker loads `dist/chat/adapters/telegram.js` at runtime. After
 * editing, regenerate the dist file with:
 *
 *     pnpm exec tsc src.legacy/chat/adapters/telegram.ts \
 *         --outDir dist --rootDir src.legacy \
 *         --module NodeNext --moduleResolution NodeNext --target ES2022 \
 *         --esModuleInterop --skipLibCheck --noEmitOnError false
 *
 * Then `node ./dist/index.js chat-daemon restart` to load the new code.
 * Without the restart, sends keep using the old in-memory adapter.
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
  /**
   * 0.7.4 (#147): true when the long-poll lost to a 409 Conflict
   * (another consumer holds the token — typically the Claude Code
   * `plugin:telegram` bun bot). Outbound sendMessage still works via
   * HTTPS, only inbound is dead. A periodic retry attempts to reclaim.
   */
  private outboundOnly = false;
  /** 0.7.4 (#147): handle for the periodic long-poll retry timer. */
  private retryTimer: NodeJS.Timeout | null = null;
  /** Retry cadence — long enough that flapping doesn't burn API quota. */
  private static readonly RETRY_INTERVAL_MS = 60_000;
  /**
   * 0.5.90 (TG.3): chat_ids for which we've already logged an allowlist
   * drop this process. The adapter silently drops messages from non-
   * allowlisted chats (correct policy — never echo policy decisions back
   * to the sender), but operators need a one-time-per-chat log line so
   * they can diagnose "why isn't my message routing?" without reading
   * source. Tracked as a Set keyed by chatIdStr; resets on restart.
   */
  private allowlistDropLogged = new Set<string>();

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
        // Silently drop on the chat side (correct — never echo policy back
        // to the sender). But log once per chat_id per process lifetime
        // (0.5.90 / TG.3) so operators can diagnose "why isn't my message
        // routing?" without reading source. The first message from a
        // newly-talking chat surfaces the drop with a hint to fix.
        if (!this.allowlistDropLogged.has(chatIdStr)) {
          this.allowlistDropLogged.add(chatIdStr);
          const chatType = m.chat.type;
          const hint =
            "add this chat_id to chat_connections.telegram.allowlist_chat_ids in ~/.opensquid/config.json to enable inbound routing";
          // eslint-disable-next-line no-console
          console.error(
            `[telegram adapter] dropped inbound from non-allowlisted chat ${chatIdStr} (type=${chatType}); ${hint}`,
          );
        }
        return;
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
    // 0.7.4 (#147) fix: rejection handler delegates to
    // handleStartRejection() so tests can exercise the 409 path
    // without spinning up grammy.
    this.startPromise = bot.start().catch((err) => this.handleStartRejection(err));
    // Yield once so the polling loop has a tick to register before the
    // gateway moves on to dispatch outbound messages.
    await new Promise((r) => setImmediate(r));
  }

  /**
   * 0.7.4 (#147): handle a rejection from `bot.start()`. Extracted
   * from inline catch handler so tests can simulate 409 without
   * needing a live grammy + colliding bot. EXPORTED VIA PROTECTED for
   * test-only direct invocation; not part of the public adapter API.
   */
  handleStartRejection(err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    const is409 = /409|Conflict/.test(msg);
    if (is409) {
      // eslint-disable-next-line no-console
      console.error(
        `[telegram adapter] long-poll lost to 409 Conflict — degrading to OUTBOUND-ONLY (outbound sendMessage still works); periodic retry every ${TelegramAdapter.RETRY_INTERVAL_MS / 1000}s`,
      );
      this.outboundOnly = true;
      this.startPromise = null;
      this.scheduleRetry();
    } else {
      // eslint-disable-next-line no-console
      console.error(`[telegram adapter] long-poll loop errored: ${msg}`);
      this.bot = null;
      this.startPromise = null;
    }
  }

  /**
   * 0.7.4 (#147): test-only seed — install a fake bot reference + mark
   * outbound-only so tests can verify isOutboundOnly() + retry timer
   * without spinning up grammy. Must be called before any
   * handleStartRejection in test context.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _testSeed(fakeBot: any): void {
    this.bot = fakeBot as GrammyBot;
  }

  /**
   * 0.7.4 (#147): test-only — clear the retry timer so tests don't
   * leak intervals after a 409 simulation.
   */
  _testClearRetryTimer(): void {
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /**
   * 0.7.4 (#147): periodically retry the long-poll while in outbound-
   * only mode. If the competing consumer disconnects, we reclaim
   * inbound transparently.
   */
  private scheduleRetry(): void {
    if (this.retryTimer) return;
    this.retryTimer = setInterval(() => {
      void this.tryReclaim();
    }, TelegramAdapter.RETRY_INTERVAL_MS);
  }

  private async tryReclaim(): Promise<void> {
    if (!this.outboundOnly || !this.bot) return;
    const bot = this.bot;
    // Fire bot.start() again; same rejection handling as the initial
    // start. If 409, stay outbound-only. If success (no rejection
    // observable yet — start() resolves only on stop()), clear the
    // outboundOnly flag and stop the retry timer.
    const next = bot.start().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      const is409 = /409|Conflict/.test(msg);
      if (!is409) {
        // eslint-disable-next-line no-console
        console.error(`[telegram adapter] retry start() errored: ${msg}`);
      }
      // Stay outbound-only; retry timer keeps running.
      return;
    });
    // Yield to let the long-poll register if it's going to succeed.
    await new Promise((r) => setImmediate(r));
    // If the bot reference is still alive and no rejection fired yet,
    // assume the long-poll is back. Reclaim inbound.
    if (this.bot && this.outboundOnly) {
      // Heuristic check: getMe still succeeds (the bot can still talk
      // to the API). If 409 already rejected `next`, that handler will
      // have run by now. We can't directly observe "start succeeded"
      // because start() doesn't resolve on success — it stays pending.
      // So we look for the absence of a fresh 409.
      try {
        await bot.api.getMe();
        this.outboundOnly = false;
        this.startPromise = next;
        if (this.retryTimer) {
          clearInterval(this.retryTimer);
          this.retryTimer = null;
        }
        // eslint-disable-next-line no-console
        console.error(`[telegram adapter] long-poll RECLAIMED — inbound restored`);
      } catch {
        // getMe failed → keep outbound-only, retry on next tick
      }
    }
  }

  async shutdown(): Promise<void> {
    if (!this.bot) return;
    // 0.7.4 (#147): stop the retry timer first so it doesn't fire
    // mid-shutdown and resurrect a dead adapter.
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
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
    this.outboundOnly = false;
  }

  /**
   * 0.7.4 (#147): introspection accessor for tests + the
   * `chat_daemon_status` MCP tool to surface "outbound-only" state to
   * operators trying to diagnose "where did my message go?"
   */
  isOutboundOnly(): boolean {
    return this.outboundOnly;
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
    const { chatId, threadId: channelThreadId } = parseTelegramChannel(message.channel);
    const opts: { reply_to_message_id?: number; message_thread_id?: number } = {};
    if (message.replyTo) {
      const n = Number(message.replyTo);
      if (Number.isFinite(n)) opts.reply_to_message_id = n;
    }
    // Explicit `message.threadId` from the caller wins over a thread id
    // embedded in the channel string. The embedded form exists so that
    // composite channel literals echoed from `chat_poll_inbox`
    // (e.g. `telegram:-1001234567890:15`) can be passed back to
    // `chat_send` verbatim without the caller having to split them.
    const effectiveThreadId = message.threadId ?? channelThreadId;
    if (effectiveThreadId !== undefined) {
      const n = Number(effectiveThreadId);
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

/**
 * Parse a Telegram channel id (with optional embedded forum-topic
 * thread id) into its native chat_id + message_thread_id parts.
 *
 * Wire format (canonical, mirrors `chat_poll_inbox` output):
 * - `telegram:<chat_id>`              → general topic, no thread
 * - `telegram:<chat_id>:<thread_id>`  → forum topic (supergroup with
 *                                       Topics enabled)
 *
 * Examples:
 * - `telegram:-1001234567890`      → `{ chatId: "-1001234567890" }`
 * - `telegram:-1001234567890:15`   → `{ chatId: "-1001234567890",
 *                                       threadId: "15" }`
 * - `telegram:8075471258`          → `{ chatId: "8075471258" }` (DM)
 *
 * Why the parser lives in the adapter (not in `gateway.ts`): Slack uses
 * a different colon-in-native-id convention (`slack:C012345:1234.5678`
 * where the trailing segment is `thread_ts`, an opaque part of the
 * native id). Telegram's `<chat_id>:<thread_id>` semantic is
 * platform-specific and shouldn't leak into the cross-platform
 * `nativeIdFromChannel` helper.
 *
 * Exported for unit testing.
 */
export function parseTelegramChannel(channel: string): {
  chatId: string;
  threadId?: string;
} {
  const colon = channel.indexOf(":");
  if (colon === -1) {
    throw new ChatGatewayError(
      `malformed channel id '${channel}'`,
      "telegram channel ids must be 'telegram:<chat_id>' or 'telegram:<chat_id>:<thread_id>'",
    );
  }
  if (channel.slice(0, colon) !== "telegram") {
    throw new ChatGatewayError(`telegram adapter received non-telegram channel: '${channel}'`);
  }
  const rest = channel.slice(colon + 1);
  if (rest.length === 0) {
    throw new ChatGatewayError(`malformed channel id '${channel}': empty chat_id`);
  }
  // chat_id is always the first segment after `telegram:`. If a second
  // colon-segment is present, it's the forum-topic message_thread_id.
  const sep = rest.indexOf(":");
  if (sep === -1) {
    return { chatId: rest };
  }
  const chatId = rest.slice(0, sep);
  const threadId = rest.slice(sep + 1);
  if (chatId.length === 0) {
    throw new ChatGatewayError(`malformed channel id '${channel}': empty chat_id`);
  }
  if (threadId.length === 0) {
    throw new ChatGatewayError(
      `malformed channel id '${channel}': empty thread_id after second colon`,
    );
  }
  if (!/^\d+$/.test(threadId)) {
    throw new ChatGatewayError(
      `malformed channel id '${channel}': thread_id must be all-digits, got '${threadId}'`,
    );
  }
  return { chatId, threadId };
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
