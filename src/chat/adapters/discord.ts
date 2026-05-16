/**
 * Discord adapter — Gateway WebSocket via discord.js (v0.7b).
 *
 * SDK: `discord.js` v14 (npm i discord.js as optionalDependency).
 * Discord's Gateway protocol is non-trivial — heartbeats, resume
 * tokens, sharding, identify backoff, zlib decompression. Rolling our
 * own WebSocket client would be ~500 LOC of fragile protocol code.
 * One big SDK we import a few symbols from is the right tradeoff.
 *
 * Connection: outbound WebSocket via `client.login(token)`. No public
 * webhook URL. Works behind any NAT.
 *
 * Intents: `Guilds`, `GuildMessages`, `MessageContent`, `DirectMessages`
 * — forgetting DirectMessages silently drops DM events, a known
 * newcomer gotcha. MESSAGE CONTENT is a privileged intent that needs
 * to be enabled in the Developer Portal but is exempt for DMs and
 * @-mentions, so personal-bot DM use works regardless.
 *
 * Dynamic import discipline matches [[telegram-adapter]] — non-discord
 * installs pay zero cost.
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
import type { DiscordConfig } from "../config.js";

// Loose duck-typed shapes against discord.js — we import the SDK
// dynamically and don't want to drag its types into the compile graph.

interface DjsUser {
  id: string;
  username: string;
  bot: boolean;
  send(text: string): Promise<DjsMessage>;
}

interface DjsChannel {
  id: string;
  isTextBased?(): boolean;
  send(
    text: string | { content: string; reply?: { messageReference: string } },
  ): Promise<DjsMessage>;
}

interface DjsMessage {
  id: string;
  content: string;
  author: DjsUser;
  channelId: string;
  channel: DjsChannel;
  createdTimestamp: number;
  mentions: { has(userOrId: DjsUser | string): boolean };
  reference?: { messageId?: string };
}

interface DjsClient {
  user: DjsUser | null;
  channels: {
    fetch(id: string): Promise<DjsChannel | null>;
  };
  users: {
    fetch(id: string): Promise<DjsUser>;
  };
  on(event: "messageCreate", handler: (m: DjsMessage) => Promise<void> | void): void;
  once(event: "ready", handler: () => void): void;
  login(token: string): Promise<string>;
  destroy(): Promise<void>;
}

export class DiscordAdapter implements ChatAdapter {
  readonly platform = "discord" as const;

  private client: DjsClient | null = null;
  private handlers: MessageHandler[] = [];
  private botUsername = "";
  private botId = "";

  constructor(private readonly config: DiscordConfig) {
    if (!config.bot_token?.trim()) {
      throw new ChatGatewayError(
        "discord adapter: bot_token is required",
        "set chat_connections.discord.bot_token in ~/.opensquid/config.json",
      );
    }
  }

  async start(): Promise<void> {
    if (this.client) return;
    let Client: new (opts: { intents: number[] }) => DjsClient;
    let GatewayIntentBits: Record<string, number>;
    try {
      const discord = (await import("discord.js")) as unknown as {
        Client: new (opts: { intents: number[] }) => DjsClient;
        GatewayIntentBits: Record<string, number>;
      };
      Client = discord.Client;
      GatewayIntentBits = discord.GatewayIntentBits;
    } catch {
      throw new ChatGatewayError(
        "discord adapter: failed to load 'discord.js' SDK",
        "run `npm install discord.js` (or reinstall opensquid without --omit=optional)",
      );
    }

    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });
    this.client = client;

    // Capture identity once the gateway handshake completes.
    const ready = new Promise<void>((resolve) => {
      client.once("ready", () => {
        const me = client.user;
        if (me) {
          this.botUsername = me.username;
          this.botId = me.id;
        }
        resolve();
      });
    });

    client.on("messageCreate", async (m) => {
      if (m.author.bot) return; // ignore bot-authored messages (including ourselves)
      // Allowlist enforcement on sender user id.
      if (
        this.config.allowlist_user_ids &&
        this.config.allowlist_user_ids.length > 0 &&
        !this.config.allowlist_user_ids.includes(m.author.id)
      ) {
        return;
      }
      const normalized: ChatMessage = {
        id: m.id,
        platform: "discord",
        channel: formatChannelId("discord", m.channelId),
        sender: m.author.username,
        senderId: m.author.id,
        text: m.content,
        receivedAt: new Date(m.createdTimestamp),
        mentionsBot: client.user ? m.mentions.has(client.user) : false,
      };
      for (const h of this.handlers) {
        try {
          await h(normalized);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // eslint-disable-next-line no-console
          console.error(`[discord adapter] handler error: ${msg}`);
        }
      }
    });

    // login() rejects on bad token; ready resolves after the handshake.
    await client.login(this.config.bot_token);
    await ready;
  }

  async shutdown(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.destroy();
    } catch {
      // best-effort
    }
    this.client = null;
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    if (!this.client) {
      throw new ChatGatewayError(
        "discord adapter: not started",
        "call gateway.start() before send()",
      );
    }
    const channelId = nativeChannelIdFromChannel(message.channel);
    const channel = await this.client.channels.fetch(channelId);
    if (!channel) {
      throw new ChatGatewayError(
        `discord adapter: channel '${channelId}' not found or bot lacks access`,
      );
    }
    const payload =
      message.replyTo !== undefined
        ? { content: message.text, reply: { messageReference: message.replyTo } }
        : message.text;
    const sent = await channel.send(payload);
    return {
      platform: "discord",
      messageId: sent.id,
      deliveredAt: new Date(sent.createdTimestamp),
    };
  }

  async identity(): Promise<{ username: string; nativeId: string }> {
    if (!this.client) {
      throw new ChatGatewayError("discord adapter: not started");
    }
    return { username: this.botUsername, nativeId: this.botId };
  }
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function nativeChannelIdFromChannel(channel: string): string {
  const idx = channel.indexOf(":");
  if (idx === -1) {
    throw new ChatGatewayError(`malformed channel id '${channel}'`);
  }
  if (channel.slice(0, idx) !== "discord") {
    throw new ChatGatewayError(`discord adapter received non-discord channel: '${channel}'`);
  }
  return channel.slice(idx + 1);
}
