/**
 * Chat-connection configuration loaded from
 * `~/.opensquid/config.json` `chat_connections` block. Per-platform
 * blocks are independent — having one configured doesn't require any
 * of the others.
 *
 * Shape:
 * ```json
 * {
 *   "version": 1,
 *   "chat_connections": {
 *     "telegram": { "bot_token": "...", "allowlist_chat_ids": ["8075471258"] },
 *     "discord":  { "bot_token": "...", "allowlist_user_ids":  ["..."] },
 *     "slack":    { "bot_token": "xoxb-...", "app_token": "xapp-...", "allowlist_user_ids": ["..."] }
 *   }
 * }
 * ```
 *
 * Tokens are stored in cleartext in `config.json`; advise users to
 * `chmod 600 ~/.opensquid/config.json` (the file lives in a hidden
 * dir already, so this is a small additional hardening — not a real
 * defense against a compromised user account).
 *
 * Ported from `src.legacy/chat/config.ts` for CAT.1b. Two relocations
 * vs. the legacy module:
 *   - The host `config.json` is read/written here directly, keyed on
 *     `OPENSQUID_HOME()` (runtime/paths), instead of the legacy
 *     `codex/store.js` data-root + `../config.js` engine helpers. The
 *     loop-engine subsystem has since been retired (opensquid is
 *     engine-free), so `config.json` is now the chat stack's own file —
 *     but we still round-trip unknown top-level keys so we never clobber
 *     a field another writer owns.
 *   - The token resolver imports from the relocated `./env-token.js`.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { OPENSQUID_HOME } from '../runtime/paths.js';

import { resolveToken, type EnvSource } from './env-token.js';

// ---------------------------------------------------------------------
// Platform identifier
//
// The legacy module imported `ChatPlatform` from the heavyweight
// `./gateway.js` (adapter base classes + manager). The port keeps the
// type local — it is the same closed union the rest of the new chat
// tree uses (cf. the Zod `Platform` enum in src/runtime/chat/inbox.ts).
// ---------------------------------------------------------------------

export type ChatPlatform = 'telegram' | 'discord' | 'slack';

// ---------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------

export interface TelegramConfig {
  bot_token: string;
  /**
   * Chat ids the bot will accept messages from. Empty = accept from any
   * chat (NOT recommended — the bot is publicly addressable via Telegram).
   */
  allowlist_chat_ids?: string[];
}

export interface DiscordConfig {
  bot_token: string;
  /** User ids whose DMs / @-mentions the bot will respond to. Empty = bot owner only. */
  allowlist_user_ids?: string[];
}

export interface SlackConfig {
  /** Bot User OAuth Token — starts with `xoxb-`. Used for Web API calls. */
  bot_token: string;
  /**
   * App-level Token — starts with `xapp-`. Required for Socket Mode
   * (the no-public-ingress connection style we use).
   */
  app_token: string;
  /** User ids the bot will respond to. Empty = bot owner only. */
  allowlist_user_ids?: string[];
}

export interface ChatConnectionsConfig {
  telegram?: TelegramConfig;
  discord?: DiscordConfig;
  slack?: SlackConfig;
}

// ---------------------------------------------------------------------
// Host config.json (chat-owned)
//
// The chat stack persists its `chat_connections` block in
// `<OPENSQUID_HOME>/config.json`. We model only the keys this module
// touches; every other top-level key is preserved verbatim on save via
// the index signature so we never drop a field a different writer owns.
// ---------------------------------------------------------------------

interface HostConfig {
  version: 1;
  chat_connections?: ChatConnectionsConfig;
  [key: string]: unknown;
}

const DEFAULT_HOST_CONFIG: HostConfig = { version: 1 };

function hostConfigPath(): string {
  return path.join(OPENSQUID_HOME(), 'config.json');
}

async function loadHostConfig(): Promise<HostConfig> {
  try {
    const raw = await fs.readFile(hostConfigPath(), 'utf8');
    const parsed = JSON.parse(raw) as HostConfig;
    if (parsed?.version === 1) return parsed;
  } catch {
    // missing or malformed — return default
  }
  return { ...DEFAULT_HOST_CONFIG };
}

async function saveHostConfig(config: HostConfig): Promise<void> {
  const p = hostConfigPath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

// ---------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------

export async function loadChatConfig(): Promise<ChatConnectionsConfig> {
  const raw = await loadHostConfig();
  // 0.7.5 (#148): overlay env-var + .env tokens atop config.json. Lets
  // the user park a Telegram bot token in ~/.loop/.env so opensquid
  // uses a DIFFERENT bot than Claude Code's plugin:telegram (no 409
  // collision possible — they're different bots). Priority is
  // env > .env > config.json (per resolveToken).
  return overlayEnvTokens(raw.chat_connections ?? {});
}

export interface ChatTokenSources {
  telegram?: EnvSource;
  discord?: EnvSource;
  slack_bot?: EnvSource;
  slack_app?: EnvSource;
  env_file_path?: string;
}

/**
 * Like loadChatConfig but also returns which source each token came
 * from. The chat-daemon uses this to log "[chat-daemon] telegram
 * bot_token source: env-file (~/.loop/.env)" so operators can debug
 * "which bot is this daemon actually using" without exposing the
 * secret.
 */
export async function loadChatConfigWithSources(): Promise<{
  config: ChatConnectionsConfig;
  sources: ChatTokenSources;
}> {
  const raw = await loadHostConfig();
  return overlayEnvTokensWithSources(raw.chat_connections ?? {});
}

export async function overlayEnvTokens(
  base: ChatConnectionsConfig,
): Promise<ChatConnectionsConfig> {
  const { config } = await overlayEnvTokensWithSources(base);
  return config;
}

async function overlayEnvTokensWithSources(
  base: ChatConnectionsConfig,
): Promise<{ config: ChatConnectionsConfig; sources: ChatTokenSources }> {
  const out: ChatConnectionsConfig = { ...base };
  const sources: ChatTokenSources = {};

  // Telegram
  const tg = await resolveToken('OPENSQUID_TELEGRAM_BOT_TOKEN', base.telegram?.bot_token);
  if (tg.value) {
    out.telegram = { ...(base.telegram ?? {}), bot_token: tg.value };
    sources.telegram = tg.source;
    if (tg.env_file_path) sources.env_file_path = tg.env_file_path;
  }

  // Discord
  const dc = await resolveToken('OPENSQUID_DISCORD_BOT_TOKEN', base.discord?.bot_token);
  if (dc.value) {
    out.discord = { ...(base.discord ?? {}), bot_token: dc.value };
    sources.discord = dc.source;
    if (dc.env_file_path && !sources.env_file_path) sources.env_file_path = dc.env_file_path;
  }

  // Slack: needs both bot_token + app_token
  const sb = await resolveToken('OPENSQUID_SLACK_BOT_TOKEN', base.slack?.bot_token);
  const sa = await resolveToken('OPENSQUID_SLACK_APP_TOKEN', base.slack?.app_token);
  if (sb.value || sa.value || base.slack) {
    out.slack = {
      ...(base.slack ?? { bot_token: '', app_token: '' }),
      bot_token: sb.value ?? base.slack?.bot_token ?? '',
      app_token: sa.value ?? base.slack?.app_token ?? '',
    };
    sources.slack_bot = sb.source;
    sources.slack_app = sa.source;
    if (sb.env_file_path && !sources.env_file_path) sources.env_file_path = sb.env_file_path;
    if (sa.env_file_path && !sources.env_file_path) sources.env_file_path = sa.env_file_path;
  }

  return { config: out, sources };
}

export async function saveChatConfig(chat: ChatConnectionsConfig): Promise<void> {
  const raw = await loadHostConfig();
  raw.chat_connections = chat;
  await saveHostConfig(raw);
}

/**
 * Set a single platform's config block. Convenience for the future
 * `opensquid chat setup <platform>` wizard.
 */
export async function setPlatformConfig<P extends ChatPlatform>(
  platform: P,
  config: P extends 'telegram' ? TelegramConfig : P extends 'discord' ? DiscordConfig : SlackConfig,
): Promise<void> {
  const chat = await loadChatConfig();
  // Cast narrows correctly per the conditional type above.
  (chat as Record<ChatPlatform, unknown>)[platform] = config;
  await saveChatConfig(chat);
}

/**
 * Forget a single platform's config block. Reverts that platform to
 * inactive on the next opensquid restart.
 */
export async function forgetPlatformConfig(platform: ChatPlatform): Promise<void> {
  const chat = await loadChatConfig();
  delete chat[platform];
  await saveChatConfig(chat);
}

// ---------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------

export interface ConfigValidationIssue {
  platform: ChatPlatform;
  field: string;
  problem: string;
}

/**
 * Surface obvious config errors without trying to validate the token
 * against the live API (that happens on adapter start). Catches
 * empty-string / undefined / shape mistakes before opening a connection.
 */
export function validateChatConfig(config: ChatConnectionsConfig): ConfigValidationIssue[] {
  const issues: ConfigValidationIssue[] = [];
  if (config.telegram) {
    if (!config.telegram.bot_token?.trim()) {
      issues.push({
        platform: 'telegram',
        field: 'bot_token',
        problem: 'empty — get one from @BotFather and run `opensquid chat setup telegram`',
      });
    } else if (!/^\d+:[A-Za-z0-9_-]+$/.test(config.telegram.bot_token)) {
      issues.push({
        platform: 'telegram',
        field: 'bot_token',
        problem: "wrong format — should look like '123456:ABC-DEF...'",
      });
    }
  }
  if (config.discord) {
    if (!config.discord.bot_token?.trim()) {
      issues.push({
        platform: 'discord',
        field: 'bot_token',
        problem: 'empty — Discord Developer Portal → Application → Bot → Reset Token',
      });
    }
  }
  if (config.slack) {
    if (!config.slack.bot_token?.trim()) {
      issues.push({
        platform: 'slack',
        field: 'bot_token',
        problem:
          'empty — api.slack.com/apps → OAuth & Permissions → Bot User OAuth Token (xoxb-...)',
      });
    } else if (!config.slack.bot_token.startsWith('xoxb-')) {
      issues.push({
        platform: 'slack',
        field: 'bot_token',
        problem: "should start with 'xoxb-' (Bot User OAuth Token, not Workspace token)",
      });
    }
    if (!config.slack.app_token?.trim()) {
      issues.push({
        platform: 'slack',
        field: 'app_token',
        problem:
          'empty — required for Socket Mode; api.slack.com/apps → Basic Information → App-Level Tokens (xapp-...)',
      });
    } else if (!config.slack.app_token.startsWith('xapp-')) {
      issues.push({
        platform: 'slack',
        field: 'app_token',
        problem: "should start with 'xapp-' (App-Level Token, NOT Bot User OAuth Token)",
      });
    }
  }
  return issues;
}

/** Which platforms have any non-empty config block? */
export function configuredPlatforms(config: ChatConnectionsConfig): ChatPlatform[] {
  const out: ChatPlatform[] = [];
  if (config.telegram) out.push('telegram');
  if (config.discord) out.push('discord');
  if (config.slack) out.push('slack');
  return out;
}
