/**
 * Audit producer → unified `AuditLog` adapters (Patch B).
 *
 * Each producer (AUTO.3 capability gate, SCHED.1 webhook server, DURABLE.4
 * resumer, AUTO.6 inbound router) ships its own audit-sink interface in a
 * producer-specific shape. The CLI.5 `AuditLog` is the single libsql-backed
 * landing table. These adapters are the glue: each `adaptXxx(auditLog)`
 * returns a sink that satisfies the producer's interface and translates
 * each event variant into a unified `AuditEntry` via `auditLog.append`.
 *
 * Single-direction dependency: producers DO NOT import `AuditLog`. Only
 * this module touches both sides. Wiring lives at the daemon construction
 * site (separate commit) — this patch ships the adapter functions + tests
 * only.
 *
 * `void auditLog.append(...)` is intentional fire-and-forget — the
 * `AuditLog` class handles its own write errors (see `audit_log.ts` init +
 * insert flow) and constraint C10 forbids audit-sink errors from
 * influencing producer verdicts. The producer's `try/catch` around the
 * sink (CapabilityGate.audit) already swallows any thrown exceptions; the
 * `Promise` returned by `append` resolves independently.
 *
 * PII discipline: no producer event variant carries raw secrets / bearer
 * tokens / signing keys. WebhookServer audit explicitly carries only
 * `subscriptionId` (never `signingSecret`); InboundRouter carries
 * `sender` (an externally-visible principal, not a credential); Resumer
 * carries error messages already stringified at the producer boundary.
 * No additional `hashDetailValue` wrapping is required at the adapter
 * boundary — producers pre-hash any sensitive value before it reaches
 * the sink.
 */

import type {
  AuditLog as CapabilityGateAuditSink,
  CapabilityRequest,
  CapabilityVerdict,
} from './capability_gate.js';
import type { AuditDecision, AuditEntry, AuditLog } from './audit_log.js';
import type {
  AuditEntry as ResumerAuditEntry,
  AuditSink as ResumerAuditSink,
} from './durable/resumer.js';
import type { WebhookAuditEntry, WebhookAuditSink } from './webhook_server.js';
import type {
  InboundRouterAuditEntry,
  InboundRouterAuditSink,
} from '../channels/inbound_router.js';

/** Injected clock — defaults to `Date.now`. Tests pass a fixed-tick fn. */
export type NowFn = () => number;

/**
 * AUTO.3 capability gate → unified audit.
 *
 * Mapping:
 *   - category = `'capability_gate'`
 *   - decision = `verdict.allowed ? 'allowed' : 'denied'`
 *   - packId   = `req.pack`
 *   - detail   = `{ event_subtype: verdict.source, capability, target,
 *                   method?, source, message? }`
 *
 * `source` is duplicated as both `event_subtype` (queryable subtype across
 * all categories) and `source` (verbatim from verdict) so downstream
 * dashboards can pivot either way.
 */
export function adaptCapabilityGate(
  auditLog: AuditLog,
  now: NowFn = Date.now,
): CapabilityGateAuditSink {
  return (verdict: CapabilityVerdict, req: CapabilityRequest): void => {
    const detail: Record<string, unknown> = {
      event_subtype: verdict.source,
      capability: req.capability,
      target: req.target,
      source: verdict.source,
    };
    if (req.method !== undefined) detail.method = req.method;
    if (verdict.message !== undefined) detail.message = verdict.message;
    void auditLog.append({
      occurredAtMs: now(),
      category: 'capability_gate',
      decision: verdict.allowed ? 'allowed' : 'denied',
      packId: req.pack,
      detail,
    });
  };
}

/**
 * SCHED.1 webhook server → unified audit.
 *
 * Mapping per event variant:
 *   - `received | dispatched | idempotent | deliver_only` → `success`
 *   - `rejected_method | rejected_unknown | rejected_hmac | rejected_rate_limit` → `denied`
 *   - `error` → `error`
 *
 * `packId` is undefined — webhook auth is daemon-level. The
 * `subscriptionId` (when present) lives in `detail` so per-subscription
 * queries route via detail-JSON filter, not the indexed column.
 */
export function adaptWebhookServer(auditLog: AuditLog, now: NowFn = Date.now): WebhookAuditSink {
  return (entry: WebhookAuditEntry): void => {
    const { event, ...rest } = entry;
    const detail: Record<string, unknown> = { event_subtype: event, ...rest };
    void auditLog.append({
      occurredAtMs: now(),
      category: 'webhook',
      decision: webhookDecision(event),
      detail,
    });
  };
}

function webhookDecision(event: WebhookAuditEntry['event']): AuditDecision {
  switch (event) {
    case 'received':
    case 'dispatched':
    case 'idempotent':
    case 'deliver_only':
      return 'success';
    case 'rejected_method':
    case 'rejected_unknown':
    case 'rejected_hmac':
    case 'rejected_rate_limit':
      return 'denied';
    case 'error':
      return 'error';
    default: {
      const _exhaustive: never = event;
      // Defensive — unknown event shouldn't reach here. Map to 'error'
      // so an unmapped variant surfaces as an alert rather than silently
      // landing in `success`.
      void _exhaustive;
      return 'error';
    }
  }
}

/**
 * DURABLE.4 resumer → unified audit.
 *
 * Mapping (per Patch B spec lock):
 *   - `resume_run | resume_skipped | resume_summary` → `success`
 *     (no current variant maps to `denied`; skips are normal control
 *     flow — pack uninstalled / version diverged — not a security
 *     verdict. `evaluator_error` skips ride along inside `resume_skipped`
 *     and stay `success` at the audit-decision level; the `reason` field
 *     in detail carries the discriminator.)
 *
 * `packId` is set when the variant carries one (`resume_run` has it;
 * `resume_summary` and `resume_skipped` don't).
 */
export function adaptResumer(auditLog: AuditLog, now: NowFn = Date.now): ResumerAuditSink {
  return (entry: ResumerAuditEntry): void => {
    const { event, ...rest } = entry;
    const detail: Record<string, unknown> = { event_subtype: event, ...rest };
    const append: AuditEntry = {
      occurredAtMs: now(),
      category: 'resume',
      decision: 'success',
      detail,
    };
    if (entry.event === 'resume_run') append.packId = entry.packId;
    void auditLog.append(append);
  };
}

/**
 * AUTO.6 inbound router → unified audit.
 *
 * Mapping per event variant:
 *   - `inbound_dispatched | inbound_subscribed` → `success`
 *   - `inbound_sender_denied` → `denied`
 *   - `inbound_unmapped | inbound_no_adapter | inbound_adapter_not_inboundable
 *      | inbound_dispatch_error` → `error`
 *
 * Uses the new `'channel_inbound'` category (Patch B extends
 * `AuditCategory`); outbound channel sends remain on `'channel_send'`.
 * `packId` pulls from `entry.pack` (every variant carries it via
 * `AuditCommon`).
 */
export function adaptInboundRouter(
  auditLog: AuditLog,
  now: NowFn = Date.now,
): InboundRouterAuditSink {
  return (entry: InboundRouterAuditEntry): void => {
    const { event, pack, ...rest } = entry;
    const detail: Record<string, unknown> = { event_subtype: event, ...rest };
    void auditLog.append({
      occurredAtMs: now(),
      category: 'channel_inbound',
      decision: inboundDecision(event),
      packId: pack,
      detail,
    });
  };
}

function inboundDecision(event: InboundRouterAuditEntry['event']): AuditDecision {
  switch (event) {
    case 'inbound_dispatched':
    case 'inbound_subscribed':
      return 'success';
    case 'inbound_sender_denied':
      return 'denied';
    case 'inbound_unmapped':
    case 'inbound_no_adapter':
    case 'inbound_adapter_not_inboundable':
    case 'inbound_dispatch_error':
      return 'error';
    default: {
      const _exhaustive: never = event;
      void _exhaustive;
      return 'error';
    }
  }
}
