/**
 * Zero-LLM deliver-only webhook path (SCHED.2).
 *
 * Subscriptions declared `deliver_only: true` skip the runtime evaluator
 * entirely: the webhook body is rendered through a Mustache template
 * directly into the `NotificationRouter`. No model invocation, no dispatch
 * into the skill evaluator — sub-second response, zero LLM cost. Matches
 * Hermes's `--deliver-only` competitive feature.
 *
 * Mustache is locked to its logic-less default: no Handlebars helpers,
 * no scripting, no `Mustache.Writer` overrides that would add eval risk.
 * HTML escaping is disabled (`Mustache.escape = identity`) because the
 * downstream sink is Telegram / Discord / Slack / Claude Code chat —
 * none of which want `&amp;` substitutions. Pack authors that want HTML
 * escaping ship a downstream channel adapter that does it explicitly.
 *
 * Empty-render handling: if the rendered text trims to empty (template
 * referenced fields that were all absent / null / empty arrays), we
 * SKIP the multicast and audit as `empty_template`. Posting empty
 * messages to alerts channels is worse than dropping — it teaches users
 * to ignore the channel.
 *
 * Secret-stripping (defense-in-depth): template authors might
 * accidentally interpolate `{{api_key}}` or `{{token}}` from a payload
 * that carries credentials. A post-render regex pass redacts likely
 * secret-bearing key/value pairs before the text leaves this module.
 *
 * Imports from: mustache, ../channels/router.js, ./webhook_subscriptions.js.
 * Imported by: src/runtime/webhook_server.ts (via daemon wiring).
 */

import Mustache from 'mustache';

import type { MulticastResult, NotificationRouter } from '../channels/router.js';
import type { RoutingConfig } from '../channels/types.js';

import type { Subscription, SubscriptionSeverity } from './webhook_subscriptions.js';

// Disable Mustache's HTML escaping at module load. The downstream sinks
// (Telegram / Discord / Slack / chat://) consume raw text, not HTML.
Mustache.escape = (s: string): string => s;

/**
 * Secret-bearing key patterns we redact post-render. The regex matches
 * `<key><sep><value>` where `key` is one of the common credential names
 * and `value` is at least 8 chars of base64-ish characters. Replacement
 * preserves the key + separator so an audit reader still sees WHERE the
 * leak would have been, just not WHAT.
 */
const SECRET_PATTERN_RE =
  /(api[_-]?key|secret|token|password|authorization)(["\s:=]+["']?)([A-Za-z0-9\-_+=]{8,})(["']?)/gi;

export interface DeliverOnlyAuditPayload {
  subscriptionId: string;
  pack: string;
  receivedAt: string;
  rendered: boolean;
  reason?: 'empty_template' | 'multicast_error' | 'misconfigured';
  emptyFieldCount?: number;
  redactedSecrets?: number;
  multicast?: MulticastResult;
}

export type DeliverOnlyAuditSink = (entry: DeliverOnlyAuditPayload) => void;

export interface DeliverOnlyResult {
  rendered: boolean;
  text?: string;
  reason?: 'empty_template' | 'multicast_error' | 'misconfigured';
  multicast?: MulticastResult;
  emptyFieldCount: number;
  redactedSecrets: number;
}

/**
 * Render `sub.template` against `body` and multicast through `router`.
 * Returns the rendered + multicast result; the caller decides response
 * shape (the webhook server always returns 200 — partial-success
 * surfaces in the audit log, never the HTTP status).
 *
 * Pre-condition: caller has verified `sub.deliverOnly === true`.
 */
export async function handleDeliverOnly(
  sub: Subscription,
  body: unknown,
  router: NotificationRouter,
  routing: RoutingConfig,
): Promise<DeliverOnlyResult> {
  // Defensive: schema validation should have caught this at load time,
  // but treat missing fields as `misconfigured` rather than throwing —
  // a malformed YAML must never crash the webhook intake.
  if (sub.template === undefined || sub.deliverTo === undefined || sub.severity === undefined) {
    return { rendered: false, reason: 'misconfigured', emptyFieldCount: 0, redactedSecrets: 0 };
  }

  const view = body === null || typeof body !== 'object' ? {} : (body as Record<string, unknown>);
  const { rendered, emptyFieldCount } = renderWithEmptyCount(sub.template, view);

  if (!rendered.trim()) {
    return { rendered: false, reason: 'empty_template', emptyFieldCount, redactedSecrets: 0 };
  }

  const { text, redactedSecrets } = stripSecrets(rendered);
  const severity: SubscriptionSeverity = sub.severity;

  const result = await router.multicast(severity, sub.pack, { text, severity }, routing);

  return {
    rendered: true,
    text,
    multicast: result,
    emptyFieldCount,
    redactedSecrets,
    ...(result.failed > 0 ? { reason: 'multicast_error' as const } : {}),
  };
}

/** Render the template + count `{{...}}` interpolations that resolved
 *  to empty. The empty-count surfaces broken integrations in audit. */
function renderWithEmptyCount(
  template: string,
  view: Record<string, unknown>,
): { rendered: string; emptyFieldCount: number } {
  const rendered = Mustache.render(template, view);
  const matches = template.match(/{{\s*([^{}#/^!>=}]+)\s*}}/g) ?? [];
  let emptyFieldCount = 0;
  for (const m of matches) {
    const path = m.replace(/^{{\s*|\s*}}$/g, '');
    if (Mustache.render(`{{${path}}}`, view) === '') emptyFieldCount += 1;
  }
  return { rendered, emptyFieldCount };
}

/** Defense-in-depth: redact obvious secret-bearing patterns from the
 *  rendered text. Returns the (possibly mutated) text + redaction count. */
export function stripSecrets(text: string): { text: string; redactedSecrets: number } {
  let count = 0;
  const out = text.replace(
    SECRET_PATTERN_RE,
    (_match, key: string, sep: string, _val, suffix: string) => {
      count += 1;
      return `${key}${sep}<redacted>${suffix}`;
    },
  );
  return { text: out, redactedSecrets: count };
}
