/**
 * slack:// adapter — outbound via @slack/web-api (`chat.postMessage`),
 * inbound via @slack/socket-mode (`SocketModeClient`).
 *
 * URI scheme: `slack://<workspace>/<channel>` where both segments are
 * `[\w-]+`. The workspace segment is informational — Slack routes by
 * the bot token's workspace, not by URI — but we keep it in the URI so
 * users can spot the destination without resolving credentials.
 *
 * Dependencies: both Slack SDKs are OPTIONAL peerDependencies, loaded
 * lazily on `start()` / `send()`. Users who never configure a Slack
 * channel never install them.
 *
 * Critical SLA: Slack requires `ack()` within 3 seconds on every inbound
 * event. The runtime contract here is "ack first, work async": the
 * adapter wraps every event listener so `ack()` is called synchronously
 * before the user-supplied handler runs, and the handler is then
 * scheduled on the next microtask. This makes it impossible for a slow
 * handler to miss the SLA.
 *
 * Security: bot + app tokens are closed over by this function and
 * scrubbed from any error path that might surface them.
 */

import type { InboundChannelEvent } from '../../runtime/event.js';
import type { ChannelAdapter, ChannelMessage, InboundSubscription, SendResult } from '../types.js';

export interface SlackAdapterOpts {
  /** Bot token (xoxb-...) for chat.postMessage and other web-api calls. */
  botToken: string;
  /** App-level token (xapp-...) for socket-mode connection. */
  appToken: string;
  /** Optional inbound event handler. Adapter acks BEFORE invoking. */
  onEvent?: (event: SlackInboundEvent) => void | Promise<void>;
  /** Workspace segment to embed in `InboundChannelEvent.channelUri` — Slack
   *  routes by token, not URI, but we keep the segment so audit logs +
   *  channel mapping read identifiably. Defaults to `'workspace'`. */
  workspace?: string;
}

export interface SlackInboundEvent {
  type: string;
  body: unknown;
}

export interface SlackAdapter extends ChannelAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Test/inspection hook — process a single inbound envelope as if it
   * arrived from Slack. ACKs synchronously, runs the user handler async. */
  handleInbound(envelope: SlackInboundEnvelope): Promise<void>;
  /**
   * AUTO.6 — attach an inbound handler that maps Slack `message` events
   * to a unified `InboundChannelEvent`. Auto-starts Socket Mode if not
   * already running. ACK still fires synchronously before any handler
   * runs (3s SLA).
   */
  subscribeInbound(
    handler: (event: InboundChannelEvent) => Promise<void>,
  ): Promise<InboundSubscription>;
}

export interface SlackInboundEnvelope {
  type: string;
  body: unknown;
  /** Slack SDK supplies this; the adapter MUST call it within 3s. */
  ack: () => Promise<void> | void;
}

interface SlackWebClient {
  chat: { postMessage(args: { channel: string; text: string }): Promise<unknown> };
}

interface SlackSocketModeClient {
  start(): Promise<unknown>;
  disconnect(): Promise<unknown>;
  on(event: string, listener: (envelope: SlackInboundEnvelope) => void | Promise<void>): void;
}

interface SlackModule {
  WebClient: new (token: string) => SlackWebClient;
}

interface SocketModeModule {
  SocketModeClient: new (opts: { appToken: string }) => SlackSocketModeClient;
}

/** Parse `slack://<workspace>/<channel>` into `{ workspace, channel }`. */
function parseUri(uri: string): { workspace: string; channel: string } | null {
  const match = /^slack:\/\/([\w-]+)\/([\w-]+)$/.exec(uri);
  if (match === null) return null;
  const workspace = match[1];
  const channel = match[2];
  if (workspace === undefined || channel === undefined) return null;
  return { workspace, channel };
}

async function loadWebApi(): Promise<SlackModule> {
  const mod = (await import('@slack/web-api')) as unknown as SlackModule;
  return { WebClient: mod.WebClient };
}

async function loadSocketMode(): Promise<SocketModeModule> {
  const mod = (await import('@slack/socket-mode')) as unknown as SocketModeModule;
  return { SocketModeClient: mod.SocketModeClient };
}

function redact(message: string, ...secrets: string[]): string {
  let out = message;
  for (const s of secrets) {
    if (s !== '') out = out.replaceAll(s, '[redacted]');
  }
  return out;
}

/**
 * Minimal Slack `event_callback`/`message` shape. Declared structurally
 * so the adapter doesn't pull `@slack/types` into our public surface.
 */
interface SlackEventCallbackBody {
  event?: {
    type?: string;
    channel?: string;
    user?: string;
    text?: string;
    thread_ts?: string;
    bot_id?: string;
    subtype?: string;
  };
}

export function slackAdapter(opts: SlackAdapterOpts): SlackAdapter {
  let web: SlackWebClient | null = null;
  let socket: SlackSocketModeClient | null = null;
  let started = false;
  const inboundListeners = new Set<(event: InboundChannelEvent) => Promise<void>>();
  const workspaceSegment = opts.workspace ?? 'workspace';

  /** Map a Slack envelope (event_callback) → unified InboundChannelEvent.
   *  Returns `null` for envelopes that don't carry a user-authored
   *  message (subtypes like bot_message, message_changed, etc). */
  function mapToInboundEvent(envelope: SlackInboundEnvelope): InboundChannelEvent | null {
    if (envelope.type !== 'event_callback' && envelope.type !== 'events_api') return null;
    const body = envelope.body as SlackEventCallbackBody | undefined;
    const ev = body?.event;
    if (ev?.type !== 'message') return null;
    // Skip bot-authored + subtyped messages — loop-break first line of
    // defense + ignore edit/delete envelopes which aren't fresh inputs.
    if (ev.bot_id !== undefined && ev.bot_id !== '') return null;
    if (ev.subtype !== undefined && ev.subtype !== '') return null;
    if (ev.channel === undefined || ev.user === undefined) return null;
    const channelUri = `slack://${workspaceSegment}/${ev.channel}`;
    const event: InboundChannelEvent = {
      kind: 'inbound_channel',
      channelUri,
      sender: ev.user,
      text: ev.text ?? '',
      receivedAt: new Date().toISOString(),
      ...(ev.thread_ts !== undefined ? { threadKey: ev.thread_ts } : {}),
    };
    return event;
  }

  /**
   * ACK-first dispatch. We invoke `envelope.ack()` synchronously (the
   * Slack SDK accepts both sync and async return), then schedule the
   * user handler on the next microtask so the ack flushes before any
   * potentially-slow work. This guarantees the 3-second SLA regardless
   * of handler latency.
   */
  async function ackThenDispatch(envelope: SlackInboundEnvelope): Promise<void> {
    // 1) ACK first — never await user code before this.
    const ackResult = envelope.ack();
    if (ackResult instanceof Promise) await ackResult;
    // 2a) Dispatch legacy onEvent — back-compat path.
    if (opts.onEvent !== undefined) {
      try {
        await opts.onEvent({ type: envelope.type, body: envelope.body });
      } catch {
        // user handler errors are swallowed — never affect ack.
      }
    }
    // 2b) Dispatch AUTO.6 inbound listeners — only when the envelope
    // carries a user-authored message event.
    if (inboundListeners.size > 0) {
      const event = mapToInboundEvent(envelope);
      if (event !== null) {
        for (const fn of inboundListeners) {
          try {
            await fn(event);
          } catch {
            // never bubble — same posture as onEvent.
          }
        }
      }
    }
  }

  /** Ensure Socket Mode is connected. Mirrors `start()` but for the
   *  subscribeInbound auto-start path — only spins up if needed. */
  async function ensureSocketStarted(): Promise<void> {
    if (socket !== null) return;
    const { SocketModeClient } = await loadSocketMode();
    const s = new SocketModeClient({ appToken: opts.appToken });
    s.on('slack_event', (envelope) => {
      void ackThenDispatch(envelope);
    });
    await s.start();
    socket = s;
  }

  return {
    scheme: 'slack',

    validate(uri: string): boolean {
      return /^slack:\/\/[\w-]+\/[\w-]+$/.test(uri);
    },

    async start(): Promise<void> {
      if (started) return;
      started = true;
      const { WebClient } = await loadWebApi();
      web = new WebClient(opts.botToken);
      // Only attach socket mode when the caller registered an inbound
      // handler — outbound-only deployments stay cheap.
      if (opts.onEvent !== undefined) {
        await ensureSocketStarted();
      }
    },

    async stop(): Promise<void> {
      if (!started) return;
      started = false;
      // Clear AUTO.6 listeners FIRST so an in-flight envelope can't reach
      // a stale handler after stop() resolves.
      inboundListeners.clear();
      if (socket !== null) {
        try {
          await socket.disconnect();
        } catch {
          // best-effort
        }
        socket = null;
      }
      web = null;
    },

    async send(uri: string, message: ChannelMessage): Promise<SendResult> {
      const parsed = parseUri(uri);
      if (parsed === null) return { ok: false, error: 'bad uri' };
      if (web === null) {
        try {
          const { WebClient } = await loadWebApi();
          web = new WebClient(opts.botToken);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return { ok: false, error: redact(msg, opts.botToken, opts.appToken) };
        }
      }
      try {
        await web.chat.postMessage({ channel: parsed.channel, text: message.text });
        return { ok: true };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, error: redact(msg, opts.botToken, opts.appToken) };
      }
    },

    async handleInbound(envelope: SlackInboundEnvelope): Promise<void> {
      await ackThenDispatch(envelope);
    },

    async subscribeInbound(
      handler: (event: InboundChannelEvent) => Promise<void>,
    ): Promise<InboundSubscription> {
      inboundListeners.add(handler);
      // Auto-attach Socket Mode if start() hasn't been called yet, OR if
      // start() ran without `onEvent` (outbound-only path). Idempotent.
      started = true;
      if (web === null) {
        const { WebClient } = await loadWebApi();
        web = new WebClient(opts.botToken);
      }
      await ensureSocketStarted();
      return {
        // eslint-disable-next-line @typescript-eslint/require-await -- async to satisfy InboundSubscription contract
        unsubscribe: async (): Promise<void> => {
          inboundListeners.delete(handler);
        },
      };
    },
  };
}
