/**
 * Channel adapter interface — transport-agnostic.
 *
 * Adapters are keyed by URI scheme (chat://, telegram://, discord://, ...)
 * and the notification router (Task 1.14) dispatches by scheme. Nothing
 * here may leak transport-specific shape (no bot tokens, webhook URLs,
 * markdown flavors, etc.) — those live in each adapter's own module.
 */

export type Severity = 'critical' | 'error' | 'warning' | 'info';

export interface ChannelMessage {
  text: string;
  severity?: Severity;
}

export interface SendResult {
  ok: boolean;
  error?: string;
}

export interface ChannelAdapter {
  /** URI scheme this adapter handles, e.g. 'chat', 'telegram'. */
  scheme: string;
  /** True iff this adapter can deliver to the given URI. */
  validate(uri: string): boolean;
  /** Deliver the message; never throws — failure is surfaced via SendResult. */
  send(uri: string, message: ChannelMessage): Promise<SendResult>;
}

/**
 * Notification routing configuration — declared by the codex, mapped to
 * concrete URIs by the user's runtime config.
 *
 * - `severityTiers`: per-severity list of abstract channel names (e.g.
 *   `['alerts', 'audit_log']`) that the codex wants notified.
 * - `perProjectOverride`: optional per-project override keyed by project
 *   id, layered on top of severity tiers. Checked first when present.
 * - `channelMapping`: abstract-name → concrete-URI mapping the user
 *   provides (e.g. `alerts` → `telegram://chat_id/topic_id`). The router
 *   special-cases the abstract name `'chat'` to `chat://`, so it does
 *   not need an explicit entry here.
 */
export interface RoutingConfig {
  severityTiers: Record<Severity, string[]>;
  perProjectOverride?: Record<string, Record<Severity, string[]>>;
  channelMapping: Record<string, string>;
}
