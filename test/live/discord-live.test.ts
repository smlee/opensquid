/**
 * Discord live-token harness — SKIPPED by default in CI.
 *
 * Opt-in via env vars:
 *   DISCORD_LIVE=1
 *   DISCORD_BOT_TOKEN=<bot token>
 *   DISCORD_GUILD_ID=<guild id>
 *   DISCORD_CHANNEL_ID=<text channel id>
 *
 * Run manually:
 *   DISCORD_LIVE=1 DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... \
 *     DISCORD_CHANNEL_ID=... pnpm vitest run test/live/discord-live.test.ts
 *
 * The harness sends one message to the configured channel and asserts a
 * truthy SendResult. No assertions about content, rate limits, or message
 * id format — Discord's API surface for those drifts more often than the
 * adapter's contract.
 */

import { describe, expect, it } from 'vitest';
import { discordAdapter } from '../../src/channels/adapters/discord.js';

const liveEnabled = process.env.DISCORD_LIVE === '1';
const token = process.env.DISCORD_BOT_TOKEN ?? '';
const guildId = process.env.DISCORD_GUILD_ID ?? '';
const channelId = process.env.DISCORD_CHANNEL_ID ?? '';
const canRun = liveEnabled && token !== '' && guildId !== '' && channelId !== '';

describe.skipIf(!canRun)('discordAdapter — live token', () => {
  it('delivers a message to the configured channel', async () => {
    const adapter = discordAdapter({ token });
    try {
      const r = await adapter.send(`discord://${guildId}/${channelId}`, {
        text: `opensquid live-token check ${new Date().toISOString()}`,
      });
      expect(r.ok).toBe(true);
    } finally {
      await adapter.stop();
    }
  }, 30_000);
});
