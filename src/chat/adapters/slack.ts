/**
 * Slack adapter — Socket Mode via @slack/socket-mode + @slack/web-api
 * (v0.7c). Skips @slack/bolt to avoid dragging Express into opensquid's
 * runtime tree.
 *
 * Two tokens required (Slack architectural decision, not opensquid's):
 *   bot_token  — `xoxb-...` Bot User OAuth Token, used for Web API calls
 *   app_token  — `xapp-...` App-Level Token with `connections:write`
 *                scope, used for the Socket Mode WebSocket
 *
 * Connection: outbound WebSocket via Socket Mode. No public webhook
 * URL, no signature verification, no 3-second response SLA scrimmage.
 * Works behind any NAT.
 *
 * Setup gotchas (surface in install docs):
 *   1. Two tokens are easy to swap — xoxb→WebClient, xapp→SocketModeClient.
 *      Our validator rejects the wrong prefix at config-load time.
 *   2. MUST `await ack()` within 3 seconds of every event even in
 *      Socket Mode, or Slack retries. We ack first, dispatch second.
 *   3. Event Subscriptions need to be configured in the Slack dashboard
 *      separately from the Socket Mode toggle — easy to miss.
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
import type { SlackConfig } from "../config.js";

// ---------------------------------------------------------------------
// Loose duck-typed shapes against Slack's SDKs. Dynamic-import only.
// ---------------------------------------------------------------------

interface SlackWebClient {
  auth: {
    test(): Promise<{
      ok: boolean;
      user_id?: string;
      user?: string;
      team_id?: string;
      bot_id?: string;
    }>;
  };
  chat: {
    postMessage(args: {
      channel: string;
      text: string;
      thread_ts?: string;
    }): Promise<{ ok: boolean; ts?: string; channel?: string }>;
  };
}

interface SlackEventPayload {
  type: string;
  subtype?: string;
  text?: string;
  user?: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
  bot_id?: string;
}

interface SlackSocketModeClient {
  on(
    event: "message",
    handler: (args: { event: SlackEventPayload; ack: () => Promise<void> }) => Promise<void> | void,
  ): void;
  on(event: "disconnect", handler: () => void): void;
  start(): Promise<void>;
  disconnect(): Promise<void>;
}

export class SlackAdapter implements ChatAdapter {
  readonly platform = "slack" as const;

  private web: SlackWebClient | null = null;
  private socket: SlackSocketModeClient | null = null;
  private handlers: MessageHandler[] = [];
  private botUsername = "";
  private botId = "";

  constructor(private readonly config: SlackConfig) {
    if (!config.bot_token?.trim()) {
      throw new ChatGatewayError(
        "slack adapter: bot_token is required",
        "set chat_connections.slack.bot_token (xoxb-...) in ~/.opensquid/config.json",
      );
    }
    if (!config.app_token?.trim()) {
      throw new ChatGatewayError(
        "slack adapter: app_token is required for Socket Mode",
        "set chat_connections.slack.app_token (xapp-...) in ~/.opensquid/config.json",
      );
    }
  }

  async start(): Promise<void> {
    if (this.socket) return;

    let WebClient: new (token: string) => SlackWebClient;
    let SocketModeClient: new (opts: { appToken: string }) => SlackSocketModeClient;
    try {
      const web = (await import("@slack/web-api")) as unknown as {
        WebClient: new (token: string) => SlackWebClient;
      };
      WebClient = web.WebClient;
    } catch {
      throw new ChatGatewayError(
        "slack adapter: failed to load '@slack/web-api' SDK",
        "run `npm install @slack/web-api @slack/socket-mode` (or reinstall without --omit=optional)",
      );
    }
    try {
      const sm = (await import("@slack/socket-mode")) as unknown as {
        SocketModeClient: new (opts: { appToken: string }) => SlackSocketModeClient;
      };
      SocketModeClient = sm.SocketModeClient;
    } catch {
      throw new ChatGatewayError(
        "slack adapter: failed to load '@slack/socket-mode' SDK",
        "run `npm install @slack/socket-mode`",
      );
    }

    this.web = new WebClient(this.config.bot_token);
    const socket = new SocketModeClient({ appToken: this.config.app_token });
    this.socket = socket;

    // Probe identity + bot_token validity in one round-trip.
    const me = await this.web.auth.test();
    if (!me.ok) {
      throw new ChatGatewayError("slack adapter: auth.test failed — bot_token may be revoked");
    }
    this.botUsername = me.user ?? "";
    this.botId = me.user_id ?? me.bot_id ?? "";

    socket.on("message", async ({ event, ack }) => {
      // ack FIRST — Slack's 3-second retry clock is unforgiving even
      // in Socket Mode. Drop the work into the handler stack after.
      await ack();
      // Filter out subtypes (channel_join, bot_message, message_changed,
      // etc.) and our own messages.
      if (event.subtype) return;
      if (event.bot_id) return;
      if (!event.text || !event.user || !event.channel) return;

      if (
        this.config.allowlist_user_ids &&
        this.config.allowlist_user_ids.length > 0 &&
        !this.config.allowlist_user_ids.includes(event.user)
      ) {
        return;
      }

      const normalized: ChatMessage = {
        id: event.ts ?? `${event.channel}-${Date.now()}`,
        platform: "slack",
        channel: formatChannelId("slack", event.channel),
        sender: event.user,
        senderId: event.user,
        text: event.text,
        receivedAt: event.ts ? new Date(Math.floor(Number(event.ts) * 1000)) : new Date(),
        mentionsBot: this.botId ? event.text.includes(`<@${this.botId}>`) : false,
      };
      for (const h of this.handlers) {
        try {
          await h(normalized);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // eslint-disable-next-line no-console
          console.error(`[slack adapter] handler error: ${msg}`);
        }
      }
    });

    await socket.start();
  }

  async shutdown(): Promise<void> {
    if (!this.socket) return;
    try {
      await this.socket.disconnect();
    } catch {
      // best-effort
    }
    this.socket = null;
    this.web = null;
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    if (!this.web) {
      throw new ChatGatewayError(
        "slack adapter: not started",
        "call gateway.start() before send()",
      );
    }
    const channel = nativeChannelIdFromChannel(message.channel);
    const sent = await this.web.chat.postMessage({
      channel,
      text: message.text,
      thread_ts: message.replyTo,
    });
    if (!sent.ok || !sent.ts) {
      throw new ChatGatewayError(`slack adapter: chat.postMessage failed for channel '${channel}'`);
    }
    return {
      platform: "slack",
      messageId: sent.ts,
      deliveredAt: new Date(Math.floor(Number(sent.ts) * 1000)),
    };
  }

  async identity(): Promise<{ username: string; nativeId: string }> {
    if (!this.web) {
      throw new ChatGatewayError("slack adapter: not started");
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
  if (channel.slice(0, idx) !== "slack") {
    throw new ChatGatewayError(`slack adapter received non-slack channel: '${channel}'`);
  }
  return channel.slice(idx + 1);
}
