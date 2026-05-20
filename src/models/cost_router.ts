/**
 * Cross-subscription cost routing (AUTO.7).
 *
 * Authoritative source: `docs/tasks/automation.md` §"Task AUTO.7" +
 * `docs/opensquid-real-design.md` §"Two-stage wedge gate" + memory
 * `project_opensquid_multi_subscription_gateway`.
 *
 * Jobs (schedules, webhooks, inbound triggers, file-change watchers) can
 * declare `cost_tier: cheap | balanced | premium` in their trigger block
 * (accepted on the Zod schema since AUTO.1; see `runtime/event.ts`). The
 * user declares concrete `subscription_pools:` per tier in
 * `~/.opensquid/config.yaml`. `pick(tier)` selects one alias via
 * round-robin within the tier, skipping pools that are currently
 * rate-limited.
 *
 * Locked rules (per spec §"learn"):
 *
 *   1. NO implicit cross-tier upgrade. Empty tier OR all-pools-rate-limited
 *      → THROW. Upgrade is the user's decision surfaced via audit log +
 *      Stage 2 wedge recommendation (`cost_outcome.ts`).
 *   2. Empty tier = config error → `EmptyTierError`. Fail-loud posture.
 *   3. Round-robin within tier (per-tier cursor). Rate-limited pools are
 *      skipped but re-enter rotation as soon as the probe clears.
 *   4. Rate-limit awareness via injected `isRateLimited(alias)` probe — the
 *      router never imports RateLimiter; the caller wires it.
 *   5. Audit log: every `pick()` decision records (tier, alias, success,
 *      reason?) via an injected sink. Engine-vocabulary discipline matches
 *      `RateLimiter.onError`.
 *   6. `recordOutcome` forwards (alias, success, latencyMs) to a sink that
 *      ultimately reaches `cost_outcome.ts` (Stage 2).
 *
 * Anti-self-grading invariant: no LLM primitive call in this file. Decision
 * inputs are EXTERNAL — rate-limit probe + caller-supplied user signal.
 * The audit-grep that anchors promote.ts's moat covers this file too.
 *
 * Imports from: nothing. Imported by: src/runtime/bootstrap.ts (future).
 */

export type CostTier = 'cheap' | 'balanced' | 'premium';

/**
 * One concrete subscription endpoint. `alias` is the model-alias name
 * resolved by ModelDispatcher; `provider` + `model` are audit-only at the
 * router layer (dispatcher branches on (mode, impl)). `rateLimit` is
 * consumed by the upstream probe — local/ollama pools typically omit it.
 */
export interface SubscriptionPool {
  alias: string;
  provider: string;
  model: string;
  rateLimit?: { rpm: number; tpm?: number };
}

/**
 * One `pick()` decision. `success=false` means the router threw
 * EmptyTierError (no pools or all rate-limited). Callers persist these
 * for `opensquid cost routing` to surface tier-bleed.
 */
export interface CostRoutingAuditEntry {
  tier: CostTier;
  alias: string | null;
  success: boolean;
  reason?: 'empty_tier' | 'all_rate_limited';
  timestamp: string;
}

/** Per-dispatch outcome record forwarded to Stage 2 (cost_outcome.ts). */
export interface CostOutcomeRecord {
  alias: string;
  success: boolean;
  latencyMs: number;
  timestamp: string;
}

export interface CostRouterOpts {
  /** Per-tier pools. Missing tier → empty (any `pick()` throws). */
  pools: Partial<Record<CostTier, SubscriptionPool[]>>;
  /** `true` = pool is currently rate-limited, skip it. Default: never. */
  isRateLimited?: (alias: string) => boolean;
  /** Audit sink; default no-op so callers can opt out. */
  audit?: (entry: CostRoutingAuditEntry) => void;
  /** Outcome sink for Stage 2; default no-op. */
  outcome?: (entry: CostOutcomeRecord) => void;
  /** Injected clock — every test passes a fake `now`. */
  now?: () => number;
}

export class EmptyTierError extends Error {
  constructor(
    public tier: CostTier,
    public reason: 'empty_tier' | 'all_rate_limited',
  ) {
    super(
      reason === 'empty_tier'
        ? `cost tier "${tier}" has no configured subscription pools — declare at least one in ~/.opensquid/config.yaml subscription_pools.${tier}`
        : `cost tier "${tier}" has pools but all are rate-limited — no implicit upgrade (locked: AUTO.7 §learn rule 1)`,
    );
    this.name = 'EmptyTierError';
  }
}

/**
 * Round-robin within tier with rate-limit-aware skipping. No implicit
 * cross-tier upgrade. Fail-loud on empty tier.
 */
export class CostRouter {
  private cursors: Record<CostTier, number> = { cheap: 0, balanced: 0, premium: 0 };
  private isRateLimited: (alias: string) => boolean;
  private auditSink: (entry: CostRoutingAuditEntry) => void;
  private outcomeSink: (entry: CostOutcomeRecord) => void;
  private now: () => number;

  constructor(private opts: CostRouterOpts) {
    this.isRateLimited = opts.isRateLimited ?? (() => false);
    this.auditSink = opts.audit ?? (() => undefined);
    this.outcomeSink = opts.outcome ?? (() => undefined);
    this.now = opts.now ?? Date.now;
  }

  /**
   * Pick one alias from the requested tier. Round-robin cursor advances
   * each call so consecutive calls rotate. Rate-limited pools are skipped;
   * if every pool is rate-limited, throws EmptyTierError rather than
   * upgrading to a higher tier.
   */
  pick(tier: CostTier): string {
    const tierPools = this.opts.pools[tier] ?? [];
    if (tierPools.length === 0) {
      this.auditSink({
        tier,
        alias: null,
        success: false,
        reason: 'empty_tier',
        timestamp: new Date(this.now()).toISOString(),
      });
      throw new EmptyTierError(tier, 'empty_tier');
    }

    const start = this.cursors[tier] % tierPools.length;
    for (let i = 0; i < tierPools.length; i++) {
      const idx = (start + i) % tierPools.length;
      const pool = tierPools[idx];
      if (pool === undefined) continue;
      if (this.isRateLimited(pool.alias)) continue;
      this.cursors[tier] = (idx + 1) % tierPools.length;
      this.auditSink({
        tier,
        alias: pool.alias,
        success: true,
        timestamp: new Date(this.now()).toISOString(),
      });
      return pool.alias;
    }

    this.auditSink({
      tier,
      alias: null,
      success: false,
      reason: 'all_rate_limited',
      timestamp: new Date(this.now()).toISOString(),
    });
    throw new EmptyTierError(tier, 'all_rate_limited');
  }

  /**
   * Record a dispatch outcome → Stage 2 wedge gate (cost_outcome.ts).
   * Async signature matches the spec's "Key code shapes" — body forwards
   * synchronously to the sink, which owns any persistence I/O.
   */
  recordOutcome(alias: string, success: boolean, latencyMs: number): Promise<void> {
    this.outcomeSink({
      alias,
      success,
      latencyMs,
      timestamp: new Date(this.now()).toISOString(),
    });
    return Promise.resolve();
  }
}
