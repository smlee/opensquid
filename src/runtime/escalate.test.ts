/* eslint-disable @typescript-eslint/require-await */
/**
 * Tests for `escalateSeverity` (AUTO.4).
 *
 * Coverage matches the spec's test fixtures + risk callouts:
 *   1. Severity always bumped to 'critical' regardless of source level.
 *   2. Routing via NotificationRouter — message reaches the configured
 *      critical-tier channels.
 *   3. No critical-tier channels → fail-loud (no_critical_channels
 *      fall-through, NO router.multicast call).
 *   4. RateLimiter integration: limiter denies → no multicast, returns
 *      `rate_limited` fall-through (paging-fatigue prevention).
 *   5. RateLimiter integration: limiter throws → `rate_limit_error`
 *      fall-through.
 *   6. RateLimiter check fired BEFORE multicast (order).
 *   7. Multicast partial-failure surfaced in MulticastResult.errors.
 *   8. Message formatting includes ruleId + original level for triage.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@libsql/client';
import type { Client } from '@libsql/client';

import { NotificationRouter } from '../channels/router.js';
import type { ChannelAdapter, RoutingConfig, Severity } from '../channels/types.js';

import { escalateSeverity } from './escalate.js';
import { RateLimiter, type PackRateLimits } from './rate_limit.js';
import type { Verdict } from './types.js';

// ---------------------------------------------------------------------------
// Test adapters — record what was sent so we can assert routing decisions.
// ---------------------------------------------------------------------------

function makeRecordingAdapter(scheme: string, opts: { failWith?: string } = {}) {
  const sent: { uri: string; text: string; severity: Severity | undefined }[] = [];
  const adapter: ChannelAdapter = {
    scheme,
    validate: (uri) => uri.startsWith(`${scheme}://`),
    send: async (uri, message) => {
      if (opts.failWith !== undefined) {
        return { ok: false, error: opts.failWith };
      }
      sent.push({ uri, text: message.text, severity: message.severity });
      return { ok: true };
    },
  };
  return { adapter, sent };
}

function makeRouting(overrides: Partial<RoutingConfig> = {}): RoutingConfig {
  return {
    severityTiers: {
      critical: ['alerts'],
      error: ['audit_log'],
      warning: ['audit_log'],
      info: ['chat'],
      ...overrides.severityTiers,
    },
    channelMapping: {
      alerts: 'telegram://-1001/42',
      audit_log: 'telegram://-1001/99',
      ...overrides.channelMapping,
    },
    ...(overrides.perProjectOverride !== undefined
      ? { perProjectOverride: overrides.perProjectOverride }
      : {}),
  };
}

const baseVerdict: Verdict = {
  level: 'warn',
  message: 'promotion blocked',
  ruleId: 'promotion-blocked',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('escalateSeverity — severity bump + routing', () => {
  it('always bumps severity to "critical" regardless of source level', async () => {
    const router = new NotificationRouter();
    const tg = makeRecordingAdapter('telegram');
    router.registerAdapter(tg.adapter);

    const result = await escalateSeverity({
      verdict: { level: 'warn', message: 'mild warning' },
      routing: makeRouting(),
      notificationRouter: router,
      packId: 'p',
    });

    expect(result.escalated).toBe(true);
    expect(result.reroutedSeverity).toBe('critical');
    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0]?.severity).toBe('critical');
  });

  it('routes to critical-tier channel list from RoutingConfig', async () => {
    const router = new NotificationRouter();
    const tg = makeRecordingAdapter('telegram');
    router.registerAdapter(tg.adapter);

    await escalateSeverity({
      verdict: baseVerdict,
      routing: makeRouting(),
      notificationRouter: router,
      packId: 'p',
    });

    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0]?.uri).toBe('telegram://-1001/42');
    expect(tg.sent[0]?.text).toContain('promotion-blocked');
    expect(tg.sent[0]?.text).toContain('warn'); // original level preserved in text
    expect(tg.sent[0]?.text).toContain('promotion blocked');
  });

  it('message formatting includes ruleId + original level for triage', async () => {
    const router = new NotificationRouter();
    const tg = makeRecordingAdapter('telegram');
    router.registerAdapter(tg.adapter);

    await escalateSeverity({
      verdict: { level: 'block', message: 'API call rejected', ruleId: 'api-block' },
      routing: makeRouting(),
      notificationRouter: router,
      packId: 'p',
    });

    expect(tg.sent[0]?.text).toContain('[api-block]');
    expect(tg.sent[0]?.text).toContain('block');
  });
});

describe('escalateSeverity — fail-loud on missing critical-tier channels (C10)', () => {
  it('no critical-tier channels configured AND no chat fallback → fall-through, NO multicast', async () => {
    const router = new NotificationRouter();
    // No chat adapter registered → no last-resort fallback either.
    // Routing config has an `alerts` tier name but the channelMapping omits it.
    const result = await escalateSeverity({
      verdict: baseVerdict,
      routing: {
        severityTiers: { critical: ['alerts'], error: [], warning: [], info: [] },
        channelMapping: {}, // alerts unmapped
      },
      notificationRouter: router,
      packId: 'p',
    });

    expect(result.escalated).toBe(false);
    expect(result.reroutedSeverity).toBe('critical');
    expect(result.fallthrough?.kind).toBe('no_critical_channels');
    expect(result.fallthrough?.reason).toMatch(/no critical-tier channels/);
  });
});

// ---------------------------------------------------------------------------
// RateLimiter integration — AUTO.2 wiring
// ---------------------------------------------------------------------------

describe('escalateSeverity — RateLimiter integration (paging fatigue)', () => {
  let client: Client;

  beforeEach(() => {
    client = createClient({ url: ':memory:' });
  });
  afterEach(() => {
    client.close();
  });

  function makeLimiter(limits: PackRateLimits, now: () => number = () => 0): RateLimiter {
    const map = new Map([['p', limits]]);
    return new RateLimiter(client, { limits: map, now });
  }

  it('limiter denies → no multicast, returns rate_limited fall-through', async () => {
    const router = new NotificationRouter();
    const tg = makeRecordingAdapter('telegram');
    router.registerAdapter(tg.adapter);

    // max: 1/minute, concurrent: 1 — first check uses the token, second
    // (which we're about to perform inline below) gets denied.
    // To make this deterministic, we prime the limiter via .check() once
    // BEFORE the escalate call, so the escalate's own check sees 0 tokens.
    const limiter = makeLimiter({
      inbound_channel: { max: 1, per: 'minute' },
    });
    await limiter.check('p', 'inbound_channel', 'promotion-blocked');

    const result = await escalateSeverity({
      verdict: baseVerdict,
      routing: makeRouting(),
      notificationRouter: router,
      packId: 'p',
      rateLimiter: limiter,
    });

    expect(result.escalated).toBe(false);
    expect(result.fallthrough?.kind).toBe('rate_limited');
    expect(result.fallthrough?.reason).toMatch(/rate-limit suppressed/);
    expect(tg.sent).toHaveLength(0); // CRITICAL: no multicast happened
  });

  it('limiter throws → rate_limit_error fall-through', async () => {
    const router = new NotificationRouter();
    const tg = makeRecordingAdapter('telegram');
    router.registerAdapter(tg.adapter);

    const limiter = {
      check: () => {
        throw new Error('libsql connection lost');
      },
    } as unknown as RateLimiter;

    const result = await escalateSeverity({
      verdict: baseVerdict,
      routing: makeRouting(),
      notificationRouter: router,
      packId: 'p',
      rateLimiter: limiter,
    });

    expect(result.escalated).toBe(false);
    expect(result.fallthrough?.kind).toBe('rate_limit_error');
    expect(result.fallthrough?.reason).toContain('libsql connection lost');
    expect(tg.sent).toHaveLength(0);
  });

  it('RateLimiter check fires BEFORE router.multicast (order)', async () => {
    const router = new NotificationRouter();
    const tg = makeRecordingAdapter('telegram');
    router.registerAdapter(tg.adapter);

    const order: string[] = [];
    const limiter = {
      check: vi.fn(async () => {
        order.push('rate_limit');
        return { allowed: true };
      }),
      // FAC.1: the slot acquired by check() is released after the paging
      // run — the order pin now covers the full acquire→run→release pair.
      release: vi.fn(async () => {
        order.push('release');
      }),
    } as unknown as RateLimiter;
    const realMulticast = router.multicast.bind(router);
    router.multicast = async (...args) => {
      order.push('multicast');
      return realMulticast(...args);
    };

    await escalateSeverity({
      verdict: baseVerdict,
      routing: makeRouting(),
      notificationRouter: router,
      packId: 'p',
      rateLimiter: limiter,
    });

    expect(order).toEqual(['rate_limit', 'multicast', 'release']);
  });

  it('no limiter supplied → multicast proceeds directly', async () => {
    const router = new NotificationRouter();
    const tg = makeRecordingAdapter('telegram');
    router.registerAdapter(tg.adapter);

    const result = await escalateSeverity({
      verdict: baseVerdict,
      routing: makeRouting(),
      notificationRouter: router,
      packId: 'p',
    });

    expect(result.escalated).toBe(true);
    expect(tg.sent).toHaveLength(1);
  });
});

describe('escalateSeverity — multicast partial failure', () => {
  it('per-adapter failure surfaces in MulticastResult.errors (escalated:true)', async () => {
    const router = new NotificationRouter();
    const tg = makeRecordingAdapter('telegram', { failWith: 'rate limited by telegram API' });
    router.registerAdapter(tg.adapter);

    const result = await escalateSeverity({
      verdict: baseVerdict,
      routing: makeRouting(),
      notificationRouter: router,
      packId: 'p',
    });

    // escalated:true because we attempted the multicast. failed:1 records
    // the partial-failure; runtime audit still sees a real attempt.
    expect(result.escalated).toBe(true);
    expect(result.multicast?.sent).toBe(0);
    expect(result.multicast?.failed).toBe(1);
    expect(result.multicast?.errors[0]).toContain('rate limited');
  });
});
