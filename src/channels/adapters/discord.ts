/**
 * discord:// adapter — outbound delivery via discord.js v14.
 *
 * URI scheme: `discord://<guild_id>/<channel_id>` (both snowflake numerics).
 *
 * Dependency: `discord.js` is an OPTIONAL peerDependency. Users who never
 * configure a Discord channel pay nothing — we lazy-load the module on
 * first `start()`/`send()`. If the dependency is missing at runtime, the
 * adapter surfaces a structured error via `SendResult` rather than
 * crashing the process.
 *
 * Intents: deliberately narrow to `GatewayIntentBits.Guilds` only. We do
 * NOT request `MessageContent` (which requires verified-bot approval
 * after 100 servers) because the adapter is outbound-only — we never
 * read message contents.
 *
 * Lifecycle: `start()` logs in + waits for the `ready` event before
 * resolving so the first `send()` cannot race the gateway handshake.
 * `stop()` destroys the client. `send()` auto-starts if not yet ready.
 *
 * Security: the bot token is closed over by this function and never
 * appears in any log output, error message, or SendResult — the same
 * discipline as the Telegram adapter.
 */

import type { InboundChannelEvent } from '../../runtime/event.js';
import type { ChannelAdapter, ChannelMessage, InboundSubscription, SendResult } from '../types.js';

export interface DiscordAdapterOpts {
  /** Bot token from the Discord Developer Portal. */
  token: string;
}

export interface DiscordAdapter extends ChannelAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * AUTO.6 — attach a `messageCreate` listener that emits a unified
   * `InboundChannelEvent`. The first call upgrades the gateway intents
   * to include `GuildMessages` + `MessageContent` (intents are immutable
   * after client construction; a subscribeInbound that comes AFTER the
   * outbound client is already running throws — callers must subscribe
   * before send() or start()).
   */
  subscribeInbound(
    handler: (event: InboundChannelEvent) => Promise<void>,
  ): Promise<InboundSubscription>;
}

/**
 * Minimal shape of the discord.js exports the adapter uses. Declared
 * here so we don't pull `discord.js` types into opensquid's public
 * surface — the real module is loaded only inside the closure.
 */
interface DiscordModule {
  Client: new (opts: { intents: number[] }) => DiscordClient;
  GatewayIntentBits: {
    Guilds: number;
    GuildMessages: number;
    MessageContent: number;
  };
}

/**
 * Minimal shape of the `messageCreate` payload the adapter reads. Declared
 * structurally so we don't pull discord.js types into our public surface.
 */
interface DiscordMessageLike {
  id: string;
  content: string;
  author: { id: string; bot?: boolean };
  channelId: string;
  guildId: string | null;
}

interface DiscordClient {
  login(token: string): Promise<string>;
  destroy(): Promise<void> | void;
  once(event: 'ready', listener: () => void): void;
  on(event: 'messageCreate', listener: (msg: DiscordMessageLike) => void): void;
  off(event: 'messageCreate', listener: (msg: DiscordMessageLike) => void): void;
  channels: {
    fetch(id: string): Promise<DiscordChannelLike | null>;
  };
}

interface DiscordChannelLike {
  isTextBased(): boolean;
  send(content: string): Promise<unknown>;
}

/** Parse `discord://<guild>/<channel>` into `{ guildId, channelId }`. */
function parseUri(uri: string): { guildId: string; channelId: string } | null {
  const match = /^discord:\/\/(\d+)\/(\d+)$/.exec(uri);
  if (match === null) return null;
  const guildId = match[1];
  const channelId = match[2];
  if (guildId === undefined || channelId === undefined) return null;
  return { guildId, channelId };
}

/** Lazy-load discord.js so it stays an optional peerDep. */
async function loadDiscordModule(): Promise<DiscordModule> {
  const mod = (await import('discord.js')) as unknown as DiscordModule;
  return { Client: mod.Client, GatewayIntentBits: mod.GatewayIntentBits };
}

export function discordAdapter(opts: DiscordAdapterOpts): DiscordAdapter {
  let client: DiscordClient | null = null;
  let ready = false;
  let starting: Promise<void> | null = null;
  // `inboundEnabled` flips before client construction. Once true, the
  // client is built with GuildMessages + MessageContent intents in
  // addition to Guilds. Discord intents are immutable after client
  // construction; once the client exists we cannot upgrade — flipping
  // this flag after start() throws on the next subscribeInbound.
  let inboundEnabled = false;
  const inboundListeners = new Set<(event: InboundChannelEvent) => Promise<void>>();
  let installedMessageHandler: ((msg: DiscordMessageLike) => void) | null = null;

  async function ensureStarted(): Promise<void> {
    if (ready) return;
    if (starting !== null) {
      await starting;
      return;
    }
    starting = (async (): Promise<void> => {
      const { Client, GatewayIntentBits } = await loadDiscordModule();
      // Spec lock: declare GuildMessages + MessageContent at client
      // creation when any subscribeInbound has been registered.
      // Otherwise stay narrow (`Guilds` only) — verified-bot approval
      // requirement past 100 servers.
      const intents = inboundEnabled
        ? [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
          ]
        : [GatewayIntentBits.Guilds];
      const c = new Client({ intents });
      const readyPromise = new Promise<void>((resolve) => {
        c.once('ready', () => {
          resolve();
        });
      });
      await c.login(opts.token);
      await readyPromise;
      client = c;
      ready = true;
      // Install ONE shared messageCreate listener for all inbound
      // subscriptions, if any are registered. We dispatch to each
      // listener inside the handler — discord.js's `off()` removes by
      // function identity, which we preserve via `installedMessageHandler`.
      if (inboundEnabled) {
        installMessageHandler(c);
      }
    })();
    try {
      await starting;
    } finally {
      starting = null;
    }
  }

  function installMessageHandler(c: DiscordClient): void {
    if (installedMessageHandler !== null) return;
    const handler = (msg: DiscordMessageLike): void => {
      // Skip messages from bots (including this bot) — prevents loop-back
      // when an outbound send triggers a fresh inbound event. Loop-break
      // belongs to the engine, but the bot-author filter is a cheap
      // first line of defense at the platform boundary.
      if (msg.author.bot === true) return;
      const event: InboundChannelEvent = {
        kind: 'inbound_channel',
        channelUri:
          msg.guildId !== null
            ? `discord://${msg.guildId}/${msg.channelId}`
            : `discord://dm/${msg.channelId}`,
        sender: msg.author.id,
        text: msg.content,
        receivedAt: new Date().toISOString(),
      };
      // Fan out to every registered listener; errors stay inside.
      for (const fn of inboundListeners) {
        void fn(event).catch(() => {
          /* swallow — never bubble to discord.js's event loop */
        });
      }
    };
    c.on('messageCreate', handler);
    installedMessageHandler = handler;
  }

  return {
    scheme: 'discord',

    validate(uri: string): boolean {
      return /^discord:\/\/\d+\/\d+$/.test(uri);
    },

    async start(): Promise<void> {
      await ensureStarted();
    },

    async stop(): Promise<void> {
      if (!ready || client === null) return;
      // Remove the messageCreate handler before destroy so an in-flight
      // event can't fire one of our inbound listeners after stop() resolves.
      if (installedMessageHandler !== null) {
        try {
          client.off('messageCreate', installedMessageHandler);
        } catch {
          // best-effort
        }
        installedMessageHandler = null;
      }
      inboundListeners.clear();
      try {
        await client.destroy();
      } catch {
        // best-effort — already torn down.
      }
      client = null;
      ready = false;
      inboundEnabled = false;
    },

    async send(uri: string, message: ChannelMessage): Promise<SendResult> {
      const parsed = parseUri(uri);
      if (parsed === null) return { ok: false, error: 'bad uri' };
      try {
        await ensureStarted();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        // Strip token if it ever appears in an error path; defense in
        // depth — discord.js may include it in some auth failures.
        return { ok: false, error: msg.replaceAll(opts.token, '[redacted]') };
      }
      if (client === null) return { ok: false, error: 'client not ready' };
      try {
        const channel = await client.channels.fetch(parsed.channelId);
        if (channel === null) return { ok: false, error: 'channel not found' };
        if (!channel.isTextBased()) {
          return { ok: false, error: 'channel not text-based' };
        }
        await channel.send(message.text);
        return { ok: true };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, error: msg.replaceAll(opts.token, '[redacted]') };
      }
    },

    async subscribeInbound(
      handler: (event: InboundChannelEvent) => Promise<void>,
    ): Promise<InboundSubscription> {
      // Intents are immutable after client construction. If we already
      // started without inbound intents, subscribeInbound is a misuse —
      // surface it loud so the operator fixes the bootstrap order.
      if (ready && !inboundEnabled) {
        throw new Error(
          'discordAdapter.subscribeInbound: client already started without inbound intents; ' +
            'call subscribeInbound BEFORE send()/start()',
        );
      }
      inboundEnabled = true;
      inboundListeners.add(handler);

      // If the client is already running (because a prior subscribeInbound
      // started it), the messageCreate handler is already installed. If
      // not, start it now so events actually flow.
      if (!ready) {
        await ensureStarted();
      }

      return {
        // eslint-disable-next-line @typescript-eslint/require-await -- async to satisfy InboundSubscription contract
        unsubscribe: async (): Promise<void> => {
          inboundListeners.delete(handler);
          // The shared messageCreate handler stays attached as long as
          // the client lives; removing it on the last unsubscribe would
          // re-install on the next subscribeInbound, which complicates
          // the bot-author filter. The set membership check inside the
          // handler is the cheap detach.
        },
      };
    },
  };
}
