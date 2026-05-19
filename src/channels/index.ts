/**
 * Channels: pluggable channel adapters for notification routing (chat,
 * Telegram, Discord, Slack, generic webhook) keyed by URI scheme.
 *
 * Public surface: the abstract types every adapter implements, plus
 * the built-in chat:// adapter. Other adapters (telegram/discord/slack)
 * land in later tasks; the router (Task 1.14) wires them via a registry.
 *
 * Imports from: secrets/ (resolved at call site by runtime).
 * Imported by: runtime/, setup/, mcp/.
 */

export type {
  ChannelAdapter,
  ChannelMessage,
  RoutingConfig,
  SendResult,
  Severity,
} from './types.js';
export { chatAdapter } from './chat.js';
export {
  telegramAdapter,
  type TelegramAdapter,
  type TelegramAdapterOpts,
} from './adapters/telegram.js';
export { NotificationRouter, type MulticastResult } from './router.js';
