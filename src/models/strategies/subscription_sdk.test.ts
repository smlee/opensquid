/**
 * Tests for subscription_sdk strategy.
 *
 * Three cases (per LLM.1 spec):
 *   1. stubbed SDK returns text → strategy returns it
 *   2. SDK throws → error propagates
 *   3. missing SDK install → meaningful error
 *
 * The seam is `opts.sdk` (matches `src/functions/subagent.ts` pattern).
 * Test 3 exercises the lazy-import path with a guaranteed-missing package
 * name to assert the wrapper's error message is helpful.
 */

import { describe, expect, it } from 'vitest';

import type { ModelAliasConfig } from '../types.js';

import { subscriptionSdkStrategy, type SubscriptionSdk } from './subscription_sdk.js';

const cfg: ModelAliasConfig = {
  mode: 'subscription',
  impl: 'sdk',
  model: 'user-supplied-model-id',
};

describe('subscriptionSdkStrategy', () => {
  it('returns text from a stubbed SDK', async () => {
    const sdk: SubscriptionSdk = {
      runAgent: async ({ model, prompt, timeoutMs }) => {
        // Assert pass-through of caller config.
        expect(model).toBe('user-supplied-model-id');
        expect(prompt).toBe('hi');
        expect(timeoutMs).toBe(30_000);
        return Promise.resolve({ text: 'hello' });
      },
    };
    const strat = subscriptionSdkStrategy(cfg, { sdk });
    const out = await strat.call('hi');
    expect(out).toBe('hello');
  });

  it('propagates errors thrown by the SDK', async () => {
    const sdk: SubscriptionSdk = {
      runAgent: () => Promise.reject(new Error('sdk boom')),
    };
    const strat = subscriptionSdkStrategy(cfg, { sdk });
    await expect(strat.call('hi')).rejects.toThrow('sdk boom');
  });

  it('throws a meaningful error when the SDK package is missing', async () => {
    // Use a guaranteed-missing package name via cfg.sdk to exercise the
    // lazy-import wrapper without relying on the real peer dep being absent.
    const missingCfg: ModelAliasConfig = {
      ...cfg,
      sdk: '@opensquid/definitely-not-installed-' + Math.random().toString(36).slice(2),
    };
    const strat = subscriptionSdkStrategy(missingCfg);
    await expect(strat.call('hi')).rejects.toThrow(/failed to load SDK package/);
  });
});
