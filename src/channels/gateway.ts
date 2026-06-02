/**
 * Chat gateway (T-CHAT-AS-TERMINAL CAT.1b) — thin outbound-dispatch +
 * lifecycle wrapper over the transport adapter map from `./factory.ts`.
 *
 * The legacy `src.legacy/chat/gateway.ts` carried a full inbound-dispatch fan
 * (`onMessage`) + a per-platform `ChatAdapter` abstraction. The new tree splits
 * those out: inbound is owned by the adapter's `subscribeTransport` →
 * `transport_inbox.routeAndWriteInbound` path (wired in the worker), so the
 * gateway's only jobs are (1) outbound `send` dispatch and (2) start/stop
 * fan-out. No inbound handler list lives here.
 *
 * The outbound `channel` string contract is LOAD-BEARING — it is the wire
 * format `src/mcp/chat-bridge-server.ts` + `src/runtime/agent_bridge/tools/
 * chat_send.ts` send over the daemon socket. `send()` parses it to an adapter
 * URI:
 *
 *   - `telegram:<chat_id>`                → telegram://<chat_id>
 *   - `telegram:<chat_id>:<thread_id>`    → telegram://<chat_id>/<thread_id>
 *   - explicit `threadId` arg overrides any thread suffix embedded in channel.
 *
 * Imports from: ./types. Imported by: ./daemon/{rpc_server,worker}.ts + tests.
 */

import type { ChannelAdapter, SendResult } from './types.js';
import type { ChatPlatform } from './factory.js';

/** Telegram forum-topic creation seam (telegram-only `create_topic` RPC). */
export type CreateTopicFn = (args: {
  chatId: string;
  name: string;
  iconColor?: number;
  iconCustomEmojiId?: string;
}) => Promise<{ message_thread_id: number; name: string }>;

export interface GatewayOpts {
  adapters: Map<ChatPlatform, ChannelAdapter>;
  /**
   * Optional telegram `createTopic` implementation (wired by the worker from
   * the telegram token). Absent ⇒ `create_topic` RPC fails cleanly.
   */
  createTopic?: CreateTopicFn;
}

export interface GatewaySendParams {
  /** `<platform>:<native_id>` or composite `telegram:<chat_id>:<thread_id>`. */
  channel: string;
  text: string;
  /** Echoed back by callers; the new telegram adapter has no reply-thread arg. */
  replyTo?: string;
  /** Explicit thread/topic id; overrides any suffix embedded in `channel`. */
  threadId?: string;
  /**
   * CAT.4 — ADDITIVE. Absolute path to a local image; when present the gateway
   * dispatches via the adapter's `sendPhoto` (text → caption) instead of the
   * text `send`. Telegram only; other platforms throw (no `sendPhoto` surface).
   */
  mediaPath?: string;
}

/** CAT.4 — structural slice of the telegram adapter's photo surface, so the
 *  gateway can route media without importing the concrete adapter type. */
interface PhotoCapableAdapter {
  sendPhoto(
    uri: string,
    opts: { path: string; caption?: string; threadId?: number },
  ): Promise<SendResult>;
}

export interface GatewaySendResult {
  ok: true;
  platform: string;
  /** Native delivered-message id from the transport (telegram echoes
   *  `message_id`); empty string only when the transport reported none. */
  messageId: string;
  deliveredAt: Date;
}

export class GatewayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GatewayError';
  }
}

/** Parsed `channel` → (platform, adapter URI). */
interface ParsedChannel {
  platform: ChatPlatform;
  uri: string;
}

/**
 * Parse the wire `channel` (+ optional explicit `threadId`) into a platform +
 * adapter URI. Telegram supports a `chat:thread` composite; an explicit
 * `threadId` arg takes precedence over the embedded suffix.
 */
export function parseChannel(channel: string, threadId?: string): ParsedChannel {
  const firstColon = channel.indexOf(':');
  if (firstColon === -1) {
    throw new GatewayError(
      `malformed channel '${channel}' — expected '<platform>:<native_id>'`,
    );
  }
  const platformRaw = channel.slice(0, firstColon);
  if (platformRaw !== 'telegram' && platformRaw !== 'discord' && platformRaw !== 'slack') {
    throw new GatewayError(`unknown platform '${platformRaw}' in channel '${channel}'`);
  }
  const rest = channel.slice(firstColon + 1);

  if (platformRaw === 'telegram') {
    // rest is `<chat_id>` or `<chat_id>:<thread_id>`.
    const secondColon = rest.indexOf(':');
    const chatId = secondColon === -1 ? rest : rest.slice(0, secondColon);
    const embeddedThread = secondColon === -1 ? undefined : rest.slice(secondColon + 1);
    const thread = threadId ?? embeddedThread;
    const uri =
      thread !== undefined && thread.length > 0
        ? `telegram://${chatId}/${thread}`
        : `telegram://${chatId}`;
    return { platform: 'telegram', uri };
  }

  // discord / slack — the daemon does not activate these (factory skips them),
  // so a send here will fail on the missing adapter. URI is the native id.
  return { platform: platformRaw, uri: `${platformRaw}://${rest}` };
}

export class ChatGateway {
  private readonly adapters: Map<ChatPlatform, ChannelAdapter>;
  private readonly createTopicFn?: CreateTopicFn;
  private started = false;

  constructor(opts: GatewayOpts) {
    this.adapters = opts.adapters;
    if (opts.createTopic !== undefined) this.createTopicFn = opts.createTopic;
  }

  /** Start every adapter's long-poll loop (telegram is the only one wired). */
  async start(): Promise<void> {
    if (this.started) return;
    await Promise.all(
      [...this.adapters.values()].map((a) => {
        // `start` exists on every concrete adapter; the base interface omits
        // it (it's lifecycle, not the dispatch surface). Duck-type call.
        const lc = a as unknown as { start?: () => Promise<void> };
        return typeof lc.start === 'function' ? lc.start() : Promise.resolve();
      }),
    );
    this.started = true;
  }

  /** Stop every adapter. Best-effort — errors are swallowed. */
  async stop(): Promise<void> {
    if (!this.started) return;
    await Promise.allSettled(
      [...this.adapters.values()].map((a) => {
        const lc = a as unknown as { stop?: () => Promise<void> };
        return typeof lc.stop === 'function' ? lc.stop() : Promise.resolve();
      }),
    );
    this.started = false;
  }

  /** Platforms currently activated (→ `list_channels` RPC). */
  activePlatforms(): ChatPlatform[] {
    return [...this.adapters.keys()];
  }

  /** The active adapter for a platform, or undefined. */
  getAdapter(platform: ChatPlatform): ChannelAdapter | undefined {
    return this.adapters.get(platform);
  }

  /** Dispatch an outbound message. Throws `GatewayError` on bad channel /
   *  missing adapter / adapter-reported send failure. */
  async send(params: GatewaySendParams): Promise<GatewaySendResult> {
    const { platform, uri } = parseChannel(params.channel, params.threadId);
    const adapter = this.adapters.get(platform);
    if (adapter === undefined) {
      throw new GatewayError(
        `no adapter active for platform '${platform}' (channel '${params.channel}')`,
      );
    }

    let result: SendResult;
    if (params.mediaPath !== undefined && params.mediaPath.length > 0) {
      // CAT.4 — media path. The adapter URI already carries the thread, so
      // sendPhoto re-derives it; text (when non-empty) becomes the caption.
      const photoAdapter = adapter as unknown as Partial<PhotoCapableAdapter>;
      if (typeof photoAdapter.sendPhoto !== 'function') {
        throw new GatewayError(
          `platform '${platform}' does not support media send (channel '${params.channel}')`,
        );
      }
      result = await photoAdapter.sendPhoto(uri, {
        path: params.mediaPath,
        ...(params.text.length > 0 ? { caption: params.text } : {}),
      });
    } else {
      result = await adapter.send(uri, { text: params.text });
    }

    if (!result.ok) {
      throw new GatewayError(result.error ?? `send failed for ${params.channel}`);
    }
    return { ok: true, platform, messageId: result.messageId ?? '', deliveredAt: new Date() };
  }

  /** Telegram `create_topic`. Throws when no createTopic seam is wired. */
  async createTopic(args: {
    platform: 'telegram';
    chatId: string;
    name: string;
    iconColor?: number;
    iconCustomEmojiId?: string;
  }): Promise<{ message_thread_id: number; name: string }> {
    if (this.createTopicFn === undefined) {
      throw new GatewayError('telegram adapter does not support topic creation (or not active)');
    }
    return this.createTopicFn({
      chatId: args.chatId,
      name: args.name,
      ...(args.iconColor !== undefined ? { iconColor: args.iconColor } : {}),
      ...(args.iconCustomEmojiId !== undefined ? { iconCustomEmojiId: args.iconCustomEmojiId } : {}),
    });
  }
}
