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
