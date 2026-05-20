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
  InboundSubscription,
  RoutingConfig,
  SendResult,
  Severity,
} from './types.js';
export {
  InboundRouter,
  type InboundBinding,
  type InboundDispatcher,
  type InboundRouterAuditEntry,
  type InboundRouterAuditSink,
  type InboundRouterOpts,
} from './inbound_router.js';
export { chatAdapter } from './chat.js';
export {
  telegramAdapter,
  type TelegramAdapter,
  type TelegramAdapterOpts,
} from './adapters/telegram.js';
export {
  discordAdapter,
  type DiscordAdapter,
  type DiscordAdapterOpts,
} from './adapters/discord.js';
export {
  slackAdapter,
  type SlackAdapter,
  type SlackAdapterOpts,
  type SlackInboundEvent,
  type SlackInboundEnvelope,
} from './adapters/slack.js';
export { webhookAdapter, type WebhookAdapterOpts } from './adapters/webhook.js';
export { NotificationRouter, type MulticastResult } from './router.js';
