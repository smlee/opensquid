/**
 * Tests for the AUTO.7 cost router.
 *
 * Acceptance per docs/tasks/automation.md §"Task AUTO.7":
 *  - Round-robin within tier
 *  - Rate-limit-aware skip
 *  - No implicit cross-tier upgrade (empty tier fails loud)
 *  - All-rate-limited tier fails loud (no implicit upgrade)
 *  - Audit log captures every (tier, alias, success/error) decision
 *  - Outcome sink forwards (alias, success, latencyMs) for Stage 2
 *  - ≥ 6 tests
 */

import { describe, expect, it } from 'vitest';

import {
  CostRouter,
  EmptyTierError,
  type CostOutcomeRecord,
  type CostRoutingAuditEntry,
  type SubscriptionPool,
} from './cost_router.js';

const fixedNow = () => Date.parse('2026-05-20T12:00:00.000Z');

function makePools(): {
  cheap: SubscriptionPool[];
  balanced: SubscriptionPool[];
  premium: SubscriptionPool[];
} {
  return {
    cheap: [
      { alias: 'gemini_free', provider: 'gemini_cli', model: 'gemini-2.0-flash' },
      { alias: 'ollama_local', provider: 'ollama', model: 'qwen2.5:7b' },
    ],
    balanced: [{ alias: 'claude_haiku', provider: 'claude_cli', model: 'claude-haiku-4-5' }],
    premium: [{ alias: 'claude_sonnet', provider: 'claude_cli', model: 'claude-sonnet-4-6' }],
  };
}

describe('CostRouter.pick — round-robin within tier', () => {
  it('rotates within the cheap tier across consecutive picks', () => {
    const pools = makePools();
    const router = new CostRouter({ pools, now: fixedNow });
    expect(router.pick('cheap')).toBe('gemini_free');
    expect(router.pick('cheap')).toBe('ollama_local');
    expect(router.pick('cheap')).toBe('gemini_free');
    expect(router.pick('cheap')).toBe('ollama_local');
  });

  it('keeps separate cursors per tier (cheap rotation does not move balanced cursor)', () => {
    const pools = {
      cheap: [
        { alias: 'cheap_a', provider: 'p', model: 'm' },
        { alias: 'cheap_b', provider: 'p', model: 'm' },
      ],
      balanced: [
        { alias: 'bal_a', provider: 'p', model: 'm' },
        { alias: 'bal_b', provider: 'p', model: 'm' },
      ],
    };
    const router = new CostRouter({ pools, now: fixedNow });
    expect(router.pick('cheap')).toBe('cheap_a');
    expect(router.pick('cheap')).toBe('cheap_b');
    // Balanced cursor should still be at index 0.
    expect(router.pick('balanced')).toBe('bal_a');
    expect(router.pick('balanced')).toBe('bal_b');
  });

  it('returns the single pool every time when tier has one pool', () => {
    const router = new CostRouter({ pools: makePools(), now: fixedNow });
    expect(router.pick('balanced')).toBe('claude_haiku');
    expect(router.pick('balanced')).toBe('claude_haiku');
    expect(router.pick('premium')).toBe('claude_sonnet');
  });
});

describe('CostRouter.pick — rate-limit-aware skip', () => {
  it('skips a rate-limited pool and picks the next clear one', () => {
    const pools = makePools();
    const limited = new Set<string>(['gemini_free']);
    const router = new CostRouter({
      pools,
      isRateLimited: (a) => limited.has(a),
      now: fixedNow,
    });
    // gemini_free is limited → ollama_local wins both times until limit clears.
    expect(router.pick('cheap')).toBe('ollama_local');
    expect(router.pick('cheap')).toBe('ollama_local');
    limited.delete('gemini_free');
    // Cursor advanced past ollama_local; next call should hit gemini_free.
    expect(router.pick('cheap')).toBe('gemini_free');
  });

  it('rotates between two unlimited pools when one is rate-limited mid-stream', () => {
    const pools = {
      cheap: [
        { alias: 'a', provider: 'p', model: 'm' },
        { alias: 'b', provider: 'p', model: 'm' },
        { alias: 'c', provider: 'p', model: 'm' },
      ],
    };
    const limited = new Set<string>();
    const router = new CostRouter({
      pools,
      isRateLimited: (alias) => limited.has(alias),
      now: fixedNow,
    });
    expect(router.pick('cheap')).toBe('a');
    expect(router.pick('cheap')).toBe('b');
    limited.add('c');
    // Skip c → wrap to a.
    expect(router.pick('cheap')).toBe('a');
  });
});

describe('CostRouter.pick — no implicit cross-tier upgrade (fail-loud)', () => {
  it('throws EmptyTierError when the requested tier has no pools', () => {
    const router = new CostRouter({
      pools: { balanced: [{ alias: 'x', provider: 'p', model: 'm' }] },
      now: fixedNow,
    });
    // cheap tier is absent → throw, do NOT fall through to balanced.
    expect(() => router.pick('cheap')).toThrow(EmptyTierError);
    try {
      router.pick('cheap');
    } catch (e) {
      expect(e).toBeInstanceOf(EmptyTierError);
      expect((e as EmptyTierError).reason).toBe('empty_tier');
      expect((e as EmptyTierError).tier).toBe('cheap');
    }
  });

  it('throws EmptyTierError with reason=all_rate_limited when every pool is limited', () => {
    const router = new CostRouter({
      pools: makePools(),
      isRateLimited: () => true,
      now: fixedNow,
    });
    expect(() => router.pick('cheap')).toThrow(EmptyTierError);
    try {
      router.pick('cheap');
    } catch (e) {
      expect((e as EmptyTierError).reason).toBe('all_rate_limited');
    }
  });

  it('never silently upgrades cheap → balanced even when balanced has capacity', () => {
    // The router must not consider balanced when cheap is exhausted.
    const router = new CostRouter({
      pools: {
        cheap: [], // explicitly empty
        balanced: [{ alias: 'claude_haiku', provider: 'claude_cli', model: 'h' }],
      },
      now: fixedNow,
    });
    expect(() => router.pick('cheap')).toThrow(EmptyTierError);
    // Balanced still works when asked directly.
    expect(router.pick('balanced')).toBe('claude_haiku');
  });
});

describe('CostRouter.pick — audit log', () => {
  it('records (tier, alias, success=true) on a successful pick', () => {
    const audit: CostRoutingAuditEntry[] = [];
    const router = new CostRouter({
      pools: makePools(),
      audit: (e) => audit.push(e),
      now: fixedNow,
    });
    router.pick('cheap');
    expect(audit).toHaveLength(1);
    expect(audit[0]?.tier).toBe('cheap');
    expect(audit[0]?.alias).toBe('gemini_free');
    expect(audit[0]?.success).toBe(true);
    expect(audit[0]?.timestamp).toBe('2026-05-20T12:00:00.000Z');
  });

  it('records (tier, alias=null, success=false, reason) on empty-tier fail-loud', () => {
    const audit: CostRoutingAuditEntry[] = [];
    const router = new CostRouter({
      pools: { balanced: [{ alias: 'x', provider: 'p', model: 'm' }] },
      audit: (e) => audit.push(e),
      now: fixedNow,
    });
    expect(() => router.pick('cheap')).toThrow(EmptyTierError);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.success).toBe(false);
    expect(audit[0]?.reason).toBe('empty_tier');
    expect(audit[0]?.alias).toBeNull();
  });

  it('records reason=all_rate_limited when every pool is limited', () => {
    const audit: CostRoutingAuditEntry[] = [];
    const router = new CostRouter({
      pools: makePools(),
      isRateLimited: () => true,
      audit: (e) => audit.push(e),
      now: fixedNow,
    });
    expect(() => router.pick('cheap')).toThrow(EmptyTierError);
    expect(audit[0]?.reason).toBe('all_rate_limited');
    expect(audit[0]?.success).toBe(false);
  });
});

describe('CostRouter.recordOutcome — Stage 2 sink', () => {
  it('forwards (alias, success, latencyMs, timestamp) to the outcome sink', async () => {
    const outcome: CostOutcomeRecord[] = [];
    const router = new CostRouter({
      pools: makePools(),
      outcome: (o) => outcome.push(o),
      now: fixedNow,
    });
    await router.recordOutcome('gemini_free', true, 245);
    await router.recordOutcome('gemini_free', false, 12_000);
    expect(outcome).toHaveLength(2);
    expect(outcome[0]).toMatchObject({
      alias: 'gemini_free',
      success: true,
      latencyMs: 245,
    });
    expect(outcome[1]).toMatchObject({
      alias: 'gemini_free',
      success: false,
      latencyMs: 12_000,
    });
  });

  it('no-ops the outcome path when no sink is configured (no throw)', async () => {
    const router = new CostRouter({ pools: makePools(), now: fixedNow });
    await expect(router.recordOutcome('x', true, 1)).resolves.toBeUndefined();
  });
});
