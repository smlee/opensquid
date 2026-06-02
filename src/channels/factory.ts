/**
 * Chat-adapter factory (T-CHAT-AS-TERMINAL CAT.1b).
 *
 * Builds the transport adapters the chat-daemon owns, from the chat-connection
 * config (`./config.ts` — `chat_connections` block + env/.env token overlay).
 * Ports `src.legacy/chat/factory.ts buildChatGateway` onto the new-tree
 * primitives: it returns the rich-transport `ChannelAdapter` map the gateway +
 * worker consume, NOT a legacy `ChatGateway` instance.
 *
 * Per-platform policy (mirrors the legacy "skip a platform with no/invalid
 * token" posture so a partial config never blocks the others):
 *
 *   - TELEGRAM (required surface): activated whenever a token resolves and the
 *     config validates. `allowlistChatIds` comes from the config block; the
 *     bot's own @username is resolved best-effort via `getMe` at build time so
 *     `subscribeTransport` can compute `mentionsBot`. A `getMe` failure leaves
 *     `botUsername` undefined (mentionsBot stays false) — never blocks build.
 *
 *   - DISCORD / SLACK: SKIPPED for now. The new-tree discord/slack adapters
 *     (`./adapters/{discord,slack}.ts`) implement the AUTO.6 `subscribeInbound`
 *     surface but NOT the CAT.1b rich `subscribeTransport` envelope the
 *     transport daemon's inbox writer needs (`transport_inbox.ts` is
 *     telegram-sourced; `InboundChatMessage` carries telegram-shaped ids).
 *     They are reported in `issues` as skipped, not silently dropped. When
 *     their adapters grow `subscribeTransport`, add them here.
 *
 * Imports from: grammy (getMe only), ./config, ./adapters/telegram, ./types.
 * Imported by: ./daemon/worker.ts + tests. NOT wired into the CLI (CAT.1d).
 */

import { Bot } from 'grammy';

import { loadChatConfig, validateChatConfig, type ChatConnectionsConfig } from './config.js';
import { telegramAdapter, type TelegramAdapter } from './adapters/telegram.js';
import type { ChannelAdapter } from './types.js';

export type ChatPlatform = 'telegram' | 'discord' | 'slack';

export interface BuildChatAdaptersOpts {
  /** Inject a pre-loaded config (skips the disk read). For tests. */
  config?: ChatConnectionsConfig;
  /**
   * Seam for `getMe` so tests don't hit the live Bot API. Given a token,
   * resolves the bot's @username (without `@`) or undefined. Defaults to a
   * real grammy `getMe` call. Best-effort — a throw is caught by the caller.
   */
  resolveBotUsername?: (token: string) => Promise<string | undefined>;
}

export interface BuildChatAdaptersResult {
  /** Active adapters keyed by platform. Only platforms with a usable token. */
  adapters: Map<ChatPlatform, ChannelAdapter>;
  /** Platforms that ended up activated (telegram first). */
  activated: ChatPlatform[];
  /** Human-readable notes: validation problems + intentionally-skipped platforms. */
  issues: string[];
}

/** Default `getMe` — a one-shot grammy Bot constructed solely for the call. */
async function defaultResolveBotUsername(token: string): Promise<string | undefined> {
  const probe = new Bot(token);
  const me = await probe.api.getMe();
  return me.username ?? undefined;
}

export async function buildChatAdapters(
  opts: BuildChatAdaptersOpts = {},
): Promise<BuildChatAdaptersResult> {
  const config = opts.config ?? (await loadChatConfig());
  const validationIssues = validateChatConfig(config);

  const adapters = new Map<ChatPlatform, ChannelAdapter>();
  const activated: ChatPlatform[] = [];
  const issues: string[] = [];

  // --- Telegram (required transport surface) ---------------------------------
  const telegramHasIssue = validationIssues.some((i) => i.platform === 'telegram');
  if (config.telegram && !telegramHasIssue) {
    const token = config.telegram.bot_token;
    const allowlistChatIds = (config.telegram.allowlist_chat_ids ?? [])
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n));

    // Resolve the bot's @username best-effort so subscribeTransport can flag
    // @-mentions. A network/auth failure is non-fatal: mentionsBot just stays
    // false (botUsername undefined). Never blocks activation.
    let botUsername: string | undefined;
    try {
      const resolve = opts.resolveBotUsername ?? defaultResolveBotUsername;
      botUsername = await resolve(token);
    } catch (err) {
      issues.push(
        `telegram: getMe failed (mentionsBot disabled): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    const adapter: TelegramAdapter = telegramAdapter({
      token,
      allowlistChatIds,
      ...(botUsername !== undefined ? { botUsername } : {}),
    });
    adapters.set('telegram', adapter);
    activated.push('telegram');
  } else if (config.telegram && telegramHasIssue) {
    for (const i of validationIssues.filter((x) => x.platform === 'telegram')) {
      issues.push(`telegram skipped — ${i.field}: ${i.problem}`);
    }
  }

  // --- Discord / Slack -------------------------------------------------------
  // Skipped: their new-tree adapters expose subscribeInbound (AUTO.6) but not
  // the CAT.1b rich subscribeTransport envelope the transport inbox writer
  // requires. Report, don't drop, so an operator sees why nothing happened.
  if (config.discord) {
    issues.push('discord skipped — adapter has no subscribeTransport (CAT.1b rich envelope) yet');
  }
  if (config.slack) {
    issues.push('slack skipped — adapter has no subscribeTransport (CAT.1b rich envelope) yet');
  }

  return { adapters, activated, issues };
}
