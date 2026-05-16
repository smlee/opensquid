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
 */

import type { OpensquidConfig } from "../config.js";
import { loadConfig, saveConfig } from "../config.js";

import type { ChatPlatform } from "./gateway.js";

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

// Extend OpensquidConfig at the use-site rather than mutating the
// type — keeps config.ts focused on engine-bin discovery and gives
// us a place to validate the chat block independently.

// ---------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------

interface ConfigWithChat extends OpensquidConfig {
  chat_connections?: ChatConnectionsConfig;
}

export async function loadChatConfig(dataRoot?: string): Promise<ChatConnectionsConfig> {
  const raw = (await loadConfig(dataRoot)) as ConfigWithChat;
  return raw.chat_connections ?? {};
}

export async function saveChatConfig(
  chat: ChatConnectionsConfig,
  dataRoot?: string,
): Promise<void> {
  const raw = (await loadConfig(dataRoot)) as ConfigWithChat;
  raw.chat_connections = chat;
  await saveConfig(raw, dataRoot);
}

/**
 * Set a single platform's config block. Convenience for the future
 * `opensquid chat setup <platform>` wizard.
 */
export async function setPlatformConfig<P extends ChatPlatform>(
  platform: P,
  config: P extends "telegram" ? TelegramConfig : P extends "discord" ? DiscordConfig : SlackConfig,
  dataRoot?: string,
): Promise<void> {
  const chat = await loadChatConfig(dataRoot);
  // Cast narrows correctly per the conditional type above.
  (chat as Record<ChatPlatform, unknown>)[platform] = config;
  await saveChatConfig(chat, dataRoot);
}

/**
 * Forget a single platform's config block. Reverts that platform to
 * inactive on the next opensquid restart.
 */
export async function forgetPlatformConfig(
  platform: ChatPlatform,
  dataRoot?: string,
): Promise<void> {
  const chat = await loadChatConfig(dataRoot);
  delete chat[platform];
  await saveChatConfig(chat, dataRoot);
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
        platform: "telegram",
        field: "bot_token",
        problem: "empty — get one from @BotFather and run `opensquid chat setup telegram`",
      });
    } else if (!/^\d+:[A-Za-z0-9_-]+$/.test(config.telegram.bot_token)) {
      issues.push({
        platform: "telegram",
        field: "bot_token",
        problem: "wrong format — should look like '123456:ABC-DEF...'",
      });
    }
  }
  if (config.discord) {
    if (!config.discord.bot_token?.trim()) {
      issues.push({
        platform: "discord",
        field: "bot_token",
        problem: "empty — Discord Developer Portal → Application → Bot → Reset Token",
      });
    }
  }
  if (config.slack) {
    if (!config.slack.bot_token?.trim()) {
      issues.push({
        platform: "slack",
        field: "bot_token",
        problem:
          "empty — api.slack.com/apps → OAuth & Permissions → Bot User OAuth Token (xoxb-...)",
      });
    } else if (!config.slack.bot_token.startsWith("xoxb-")) {
      issues.push({
        platform: "slack",
        field: "bot_token",
        problem: "should start with 'xoxb-' (Bot User OAuth Token, not Workspace token)",
      });
    }
    if (!config.slack.app_token?.trim()) {
      issues.push({
        platform: "slack",
        field: "app_token",
        problem:
          "empty — required for Socket Mode; api.slack.com/apps → Basic Information → App-Level Tokens (xapp-...)",
      });
    } else if (!config.slack.app_token.startsWith("xapp-")) {
      issues.push({
        platform: "slack",
        field: "app_token",
        problem: "should start with 'xapp-' (App-Level Token, NOT Bot User OAuth Token)",
      });
    }
  }
  return issues;
}

/** Which platforms have any non-empty config block? */
export function configuredPlatforms(config: ChatConnectionsConfig): ChatPlatform[] {
  const out: ChatPlatform[] = [];
  if (config.telegram) out.push("telegram");
  if (config.discord) out.push("discord");
  if (config.slack) out.push("slack");
  return out;
}
