/**
 * Escalate drift policy runtime (AUTO.4).
 *
 * Authoritative source: the automation planning notes [not retained — this header is the authority] AUTO.4.
 *
 * Semantics: when a verdict's drift response is `escalate`, the runtime
 * bumps the severity tier to `'critical'` (regardless of the original
 * verdict level) and routes the message via `NotificationRouter` using the
 * critical-tier channel list. The point is paging — a verdict that the pack
 * author judged "important enough to escalate" goes to the user's loudest
 * channel, not the default chat surface.
 *
 * RATE-LIMIT integration (locked):
 *
 *   AUTO.2's `RateLimiter` MUST apply on the escalate path, gated under the
 *   `inbound_channel` trigger kind (closest fit — outbound critical pages
 *   are paging-fatigue events). Without rate-limiting, a misbehaving rule
 *   that fires on every event would page the user 1000× per minute and
 *   train them to ignore alerts. The limiter is optional in the function
 *   signature so unit tests can omit it, but the production wiring path
 *   ALWAYS supplies one. When the limiter denies, we degrade to
 *   `notify_pause` (severity 'critical' preserved) and surface the
 *   rate-limit reason in the audit log — the operator can see WHY a page
 *   was suppressed.
 *
 * FAIL-LOUD on empty critical-tier channels:
 *
 *   If `NotificationRouter.resolve()` returns zero targets for the critical
 *   tier (no critical-tier channel mapped, AND the chat-fallback adapter is
 *   not registered), we DO NOT silently drop the page. Returns a
 *   `notify_pause` fall-through descriptor with `severity: 'critical'` and
 *   a reason that names the empty-channels condition; the audit sink picks
 *   it up. This matches the spec risk callout + the AUTO.2 RateLimiter's
 *   fail-closed posture.
 *
 * Engine-vocabulary: speaks in severity / channel / verdict / pack only.
 *
 * Imports from: ./types.js, ./rate_limit.js, ../channels/router.js, ../channels/types.js.
 * Imported by: drift-response runtime wiring (hooks layer — after AUTO.4 ships).
 */

import type { NotificationRouter, MulticastResult } from '../channels/router.js';
import type { ChannelMessage, RoutingConfig } from '../channels/types.js';

import type { RateLimiter } from './rate_limit.js';
// T-ASC ASC.3: escalate only handles message-bearing verdicts. Directive
// verdicts flow through DispatchResult.directives, never through the
// escalation channel path.
import type { MessageVerdict as Verdict } from './types.js';

/**
 * Outcome of one escalate cycle. `escalated: true` ⇒ multicast attempted
 * (the `MulticastResult` carries partial-success accounting from
 * NotificationRouter — `sent` may be 0 if every adapter failed; that's NOT
 * the same as no-channels). `escalated: false` ⇒ caller MUST route to
 * `notify_pause` with severity 'critical' using `fallthrough.reason`.
 */
export interface EscalateResult {
  escalated: boolean;
  reroutedSeverity: 'critical';
  multicast: MulticastResult | null;
  fallthrough?: {
    reason: string;
    kind: 'no_critical_channels' | 'rate_limited' | 'rate_limit_error';
  };
}

export interface EscalateDeps {
  /** The verdict being escalated (any drift level — message preserved). */
  verdict: Verdict;
  /** Routing config from the user's notifications.yaml. */
  routing: RoutingConfig;
  /** NotificationRouter instance from the channel stack. */
  notificationRouter: NotificationRouter;
  /** Pack name — needed for rate-limit bucket keying. */
  packId: string;
  /** Optional project id for per-project channel overrides. */
  project?: string | null;
  /**
   * Optional rate limiter. AUTO.2 wiring. When supplied, the limiter's
   * `inbound_channel` bucket applies to outbound critical pages —
   * paging-fatigue prevention per the spec risk callout.
   */
  rateLimiter?: RateLimiter;
  /** Bucket key for the rate limiter; defaults to verdict.ruleId or 'default'. */
  rateLimitKey?: string;
}

/**
 * Bump severity to 'critical' and reroute via NotificationRouter.
 *
 * Pure-ish: no recursion, no auto-correct, no halt. The single async path
 * is the optional rate-limit check + the router multicast. Caller awaits
 * the returned promise and acts on `escalated` boolean.
 */
export async function escalateSeverity(deps: EscalateDeps): Promise<EscalateResult> {
  const { verdict, routing, notificationRouter, packId, project = null, rateLimiter } = deps;
  const reroutedSeverity = 'critical' as const;

  // 1. Rate-limit check (AUTO.2 integration). Locked: `inbound_channel`
  //    trigger kind is the closest fit for outbound critical paging.
  const rateLimitKey = deps.rateLimitKey ?? verdict.ruleId ?? 'default';
  if (rateLimiter !== undefined) {
    const key = rateLimitKey;
    let decision;
    try {
      decision = await rateLimiter.check(packId, 'inbound_channel', key);
    } catch (e) {
      return {
        escalated: false,
        reroutedSeverity,
        multicast: null,
        fallthrough: {
          kind: 'rate_limit_error',
          reason: `escalate: rate limiter threw: ${String(e)}`,
        },
      };
    }
    if (!decision.allowed) {
      return {
        escalated: false,
        reroutedSeverity,
        multicast: null,
        fallthrough: {
          kind: 'rate_limited',
          reason: `escalate: rate-limit suppressed page (${decision.reason ?? 'unknown'})${
            decision.retryAfterMs !== undefined ? `; retry in ${decision.retryAfterMs}ms` : ''
          }`,
        },
      };
    }
  }

  // FAC.1 (wg-8f7d9b919a40): the concurrent slot acquired by the allowed
  // check() above guards the paging run — every exit below (zero-target
  // fallthrough, multicast completion, throws) releases it. The deny/throw
  // paths already returned, so reaching here with a limiter means acquired.
  try {
    // 2. Resolve targets BEFORE sending. If zero, fail-loud + fall through to
    //    notify_pause (C10: no silent drops).
    const targets = notificationRouter.resolve(reroutedSeverity, project, routing);
    if (targets.length === 0) {
      return {
        escalated: false,
        reroutedSeverity,
        multicast: null,
        fallthrough: {
          kind: 'no_critical_channels',
          reason: `escalate: no critical-tier channels configured (project=${project ?? '∅'}); page suppressed`,
        },
      };
    }

    // 3. Multicast. NotificationRouter swallows per-adapter throws and
    //    reports partial success via `MulticastResult.errors`.
    const message: ChannelMessage = {
      text: formatEscalateMessage(verdict),
      severity: reroutedSeverity,
    };
    const multicast = await notificationRouter.multicast(
      reroutedSeverity,
      project,
      message,
      routing,
    );

    return { escalated: true, reroutedSeverity, multicast };
  } finally {
    if (rateLimiter !== undefined) {
      await rateLimiter.release(packId, 'inbound_channel', rateLimitKey);
    }
  }
}

// ---------------------------------------------------------------------------
// Message formatting — minimal, deterministic, no consumer vocabulary.
//
// The rule id is included when present so on-call can pivot from the page
// to the audit log quickly. The original verdict level is preserved in the
// message text even though `reroutedSeverity` is always 'critical' — the
// difference matters for triage ("warn-level escalated" vs "block-level
// escalated").
// ---------------------------------------------------------------------------

function formatEscalateMessage(verdict: Verdict): string {
  const prefix = verdict.ruleId !== undefined ? `[${verdict.ruleId}] ` : '';
  return `${prefix}escalated (${verdict.level}): ${verdict.message}`;
}
