// src/runtime/ralph/route_on_shipped.ts — GF.3 (T-gitflow-integration-fix, scope-3): the config-driven,
// FAIL-VISIBLE integration route the loop's `onShipped` runs after a SHIPPED item. A TOTAL function over the
// resolved `environments` (GF.1) with INJECTED effects, so it is unit-testable with no git/gh:
//   • has-stage (env.staging set) → integrate the item's work into `staging` (via the config-driven SSOT
//     `integrateBranchToStage`, which uses GF.4's FIXED `mergeToStage` + GF.7's `ensureProductionPr`), then the
//     staging→production PR is ensured by that SSOT.
//   • no-stage → ensure the loop-branch(local) → production PR directly (GF.7).
// A genuine integration FAILURE is SURFACED (returned `integrated:false`, logged live by the caller) — NEVER
// swallowed: the missing durable target commit then blocks GF.2's SHIPPED close. The fail-open swallow that caused
// the phantom-ship bug (removed in ada8519) is NOT reintroduced.
import type { ResolvedEnvironments } from '../../packs/discovery.js';

/** The injected effects `routeOnShipped` composes — the production wiring binds the release SSOT + the auto-PR. */
export interface RouteDeps {
  taskId: string;
  root: string;
  /** Config-driven staged integrate: local → env.staging (GF.4 fixed context + rc-tag SSOT) + staging→production PR (GF.7). */
  integrateToStaging: (
    env: ResolvedEnvironments,
    root: string,
  ) => Promise<{ integrated: boolean; prUrl?: string }>;
  /** GF.7 — the idempotent no-stage direct auto-PR (loop-branch/local → production). */
  ensureProductionPr: (env: ResolvedEnvironments, root: string) => Promise<{ url: string }>;
}

/** The discriminated route result the caller logs live (fail-visible). */
export interface RouteResult {
  routed: 'staged' | 'direct';
  integrated: boolean;
  prUrl?: string;
  reason?: string;
}

/** GF.3 — the total, pure-branch route over `environments`. `env` is guaranteed non-null (the caller no-ops when
 *  `resolveEnvironments` returns null — an unconfigured project is not on the automated git-flow). */
export async function routeOnShipped(
  env: ResolvedEnvironments,
  d: RouteDeps,
): Promise<RouteResult> {
  if (env.staging !== undefined) {
    const { integrated, prUrl } = await d.integrateToStaging(env, d.root); // local → staging → production PR
    if (!integrated)
      return { routed: 'staged', integrated: false, reason: 'stage-integration-failed' }; // FAIL-VISIBLE
    return prUrl !== undefined
      ? { routed: 'staged', integrated: true, prUrl }
      : { routed: 'staged', integrated: true };
  }
  const { url } = await d.ensureProductionPr(env, d.root); // no stage → loop-branch(local) → production PR
  return { routed: 'direct', integrated: true, prUrl: url };
}
