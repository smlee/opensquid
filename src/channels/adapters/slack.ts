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

import type { ChannelAdapter, ChannelMessage, SendResult } from '../types.js';

export interface SlackAdapterOpts {
  /** Bot token (xoxb-...) for chat.postMessage and other web-api calls. */
  botToken: string;
  /** App-level token (xapp-...) for socket-mode connection. */
  appToken: string;
  /** Optional inbound event handler. Adapter acks BEFORE invoking. */
  onEvent?: (event: SlackInboundEvent) => void | Promise<void>;
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

export function slackAdapter(opts: SlackAdapterOpts): SlackAdapter {
  let web: SlackWebClient | null = null;
  let socket: SlackSocketModeClient | null = null;
  let started = false;

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
    // 2) Dispatch user handler async — never throws into the caller.
    if (opts.onEvent !== undefined) {
      try {
        await opts.onEvent({ type: envelope.type, body: envelope.body });
      } catch {
        // user handler errors are swallowed — never affect ack.
      }
    }
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
        const { SocketModeClient } = await loadSocketMode();
        const s = new SocketModeClient({ appToken: opts.appToken });
        // Catch-all: every event must ack first.
        s.on('slack_event', (envelope) => {
          // Fire-and-forget; ackThenDispatch handles errors internally.
          void ackThenDispatch(envelope);
        });
        await s.start();
        socket = s;
      }
    },

    async stop(): Promise<void> {
      if (!started) return;
      started = false;
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
  };
}
