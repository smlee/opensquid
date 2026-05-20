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

import type { ChannelAdapter, ChannelMessage, SendResult } from '../types.js';

export interface DiscordAdapterOpts {
  /** Bot token from the Discord Developer Portal. */
  token: string;
}

export interface DiscordAdapter extends ChannelAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Minimal shape of the discord.js exports the adapter uses. Declared
 * here so we don't pull `discord.js` types into opensquid's public
 * surface — the real module is loaded only inside the closure.
 */
interface DiscordModule {
  Client: new (opts: { intents: number[] }) => DiscordClient;
  GatewayIntentBits: { Guilds: number };
}

interface DiscordClient {
  login(token: string): Promise<string>;
  destroy(): Promise<void> | void;
  once(event: 'ready', listener: () => void): void;
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

  async function ensureStarted(): Promise<void> {
    if (ready) return;
    if (starting !== null) {
      await starting;
      return;
    }
    starting = (async (): Promise<void> => {
      const { Client, GatewayIntentBits } = await loadDiscordModule();
      const c = new Client({ intents: [GatewayIntentBits.Guilds] });
      const readyPromise = new Promise<void>((resolve) => {
        c.once('ready', () => {
          resolve();
        });
      });
      await c.login(opts.token);
      await readyPromise;
      client = c;
      ready = true;
    })();
    try {
      await starting;
    } finally {
      starting = null;
    }
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
      try {
        await client.destroy();
      } catch {
        // best-effort — already torn down.
      }
      client = null;
      ready = false;
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
  };
}
