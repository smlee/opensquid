// src/runtime/ralph/route_on_shipped.test.ts — GF.3: routeOnShipped is a TOTAL, pure-branch route over the
// resolved `environments` with INJECTED effects. These tests exercise every branch with PURE stubs (no git/gh),
// asserting both the discriminated result AND the exact dependency call-fan (fail-visible, no fail-open swallow).
import { describe, it, expect, vi } from 'vitest';
import type { ResolvedEnvironments } from '../../packs/discovery.js';
import { routeOnShipped, type RouteDeps } from './route_on_shipped.js';

const hasStageEnv: ResolvedEnvironments = { production: 'main', staging: 'stage', local: 'feat/x' };
const noStageEnv: ResolvedEnvironments = { production: 'main', local: 'feat/x' };

describe('routeOnShipped (GF.3)', () => {
  it('has-stage success → routed:staged, integrated:true, prUrl passthrough; ensureProductionPr NOT called', async () => {
    const integrateToStaging = vi.fn(() => Promise.resolve({ integrated: true, prUrl: 'u' }));
    const ensureProductionPr = vi.fn(() => Promise.resolve({ url: 'unused' }));
    const d: RouteDeps = { taskId: 't1', root: '/repo', integrateToStaging, ensureProductionPr };

    const result = await routeOnShipped(hasStageEnv, d);

    expect(result).toEqual({ routed: 'staged', integrated: true, prUrl: 'u' });
    expect(integrateToStaging).toHaveBeenCalledTimes(1);
    expect(integrateToStaging).toHaveBeenCalledWith(hasStageEnv, '/repo');
    expect(ensureProductionPr).not.toHaveBeenCalled();
  });

  it('has-stage failure → FAIL-VISIBLE routed:staged, integrated:false, reason:stage-integration-failed', async () => {
    const integrateToStaging = vi.fn(() => Promise.resolve({ integrated: false }));
    const ensureProductionPr = vi.fn(() => Promise.resolve({ url: 'unused' }));
    const d: RouteDeps = { taskId: 't2', root: '/repo', integrateToStaging, ensureProductionPr };

    const result = await routeOnShipped(hasStageEnv, d);

    expect(result).toEqual({
      routed: 'staged',
      integrated: false,
      reason: 'stage-integration-failed',
    });
    expect(result.prUrl).toBeUndefined();
    expect(integrateToStaging).toHaveBeenCalledTimes(1);
    // The SSOT owns the PR internally on failure — routeOnShipped does NOT call ensureProductionPr.
    expect(ensureProductionPr).not.toHaveBeenCalled();
  });

  it('carries the configured semantic local branch through both environment routes', async () => {
    const seen: string[] = [];
    const integrateToStaging = vi.fn((env: ResolvedEnvironments) => {
      seen.push(env.local);
      return Promise.resolve({ integrated: true });
    });
    const ensureProductionPr = vi.fn((env: ResolvedEnvironments) => {
      seen.push(env.local);
      return Promise.resolve({ url: 'pr' });
    });

    await routeOnShipped(hasStageEnv, {
      taskId: 'staged',
      root: '/repo',
      integrateToStaging,
      ensureProductionPr,
    });
    await routeOnShipped(noStageEnv, {
      taskId: 'direct',
      root: '/repo',
      integrateToStaging,
      ensureProductionPr,
    });

    expect(seen).toEqual(['feat/x', 'feat/x']);
  });

  it('no-stage → routed:direct auto-PR; integrateToStaging NOT called', async () => {
    const integrateToStaging = vi.fn(() => Promise.resolve({ integrated: true, prUrl: 'nope' }));
    const ensureProductionPr = vi.fn(() => Promise.resolve({ url: 'pr' }));
    const d: RouteDeps = { taskId: 't3', root: '/repo', integrateToStaging, ensureProductionPr };

    const result = await routeOnShipped(noStageEnv, d);

    expect(result).toEqual({ routed: 'direct', integrated: true, prUrl: 'pr' });
    expect(ensureProductionPr).toHaveBeenCalledTimes(1);
    expect(ensureProductionPr).toHaveBeenCalledWith(noStageEnv, '/repo');
    expect(integrateToStaging).not.toHaveBeenCalled();
  });
});
