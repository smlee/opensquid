/**
 * Tests for api_anthropic strategy.
 *
 * Three cases (per LLM.2 spec):
 *   1. happy path (mocked SDK returns text block) → text returned
 *   2. 429 then 200 → retry succeeds (uses fake timers so the 1s sleep
 *      doesn't slow the suite)
 *   3. missing API key → throw "ANTHROPIC_API_KEY not configured"
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SecretResolver } from '../../secrets/types.js';
import type { ModelAliasConfig } from '../types.js';

import {
  apiAnthropicStrategy,
  type AnthropicSdkModule,
  type AnthropicMessageResponse,
} from './api_anthropic.js';

const cfg: ModelAliasConfig = {
  mode: 'api',
  provider: 'anthropic',
  model: 'user-supplied-model-id',
};

function makeSecrets(map: Record<string, string | null>): SecretResolver {
  return {
    resolve: (uri: string) => Promise.resolve(map[uri] ?? null),
  };
}

function makeSdkModule(handler: (call: number) => Promise<AnthropicMessageResponse>): {
  module: AnthropicSdkModule;
  callCount: () => number;
} {
  let calls = 0;
  const module: AnthropicSdkModule = {
    default: class {
      constructor(_opts: { apiKey: string }) {
        // no-op
      }
      messages = {
        create: () => {
          calls += 1;
          return handler(calls);
        },
      };
    },
  };
  return { module, callCount: () => calls };
}

describe('apiAnthropicStrategy', () => {
  it('returns text on happy path', async () => {
    const secrets = makeSecrets({ 'env:ANTHROPIC_API_KEY': 'sk-test' });
    const { module } = makeSdkModule(() =>
      Promise.resolve({ content: [{ type: 'text', text: 'hello' }] }),
    );
    const strat = apiAnthropicStrategy(cfg, secrets, { sdkModule: module });
    const out = await strat.call('hi');
    expect(out).toBe('hello');
  });

  describe('with fake timers', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('retries on 429 and returns on success', async () => {
      const secrets = makeSecrets({ 'env:ANTHROPIC_API_KEY': 'sk-test' });
      const { module, callCount } = makeSdkModule((call) => {
        if (call === 1) {
          const err = Object.assign(new Error('rate'), { status: 429 });
          return Promise.reject(err);
        }
        return Promise.resolve({ content: [{ type: 'text', text: 'recovered' }] });
      });
      const strat = apiAnthropicStrategy(cfg, secrets, { sdkModule: module });
      const promise = strat.call('hi');
      // Advance through the 1s backoff before the second attempt.
      await vi.advanceTimersByTimeAsync(1000);
      const out = await promise;
      expect(out).toBe('recovered');
      expect(callCount()).toBe(2);
    });
  });

  it('throws when ANTHROPIC_API_KEY is not configured', async () => {
    const secrets = makeSecrets({});
    const { module } = makeSdkModule(() =>
      Promise.resolve({ content: [{ type: 'text', text: 'unused' }] }),
    );
    const strat = apiAnthropicStrategy(cfg, secrets, { sdkModule: module });
    await expect(strat.call('hi')).rejects.toThrow('ANTHROPIC_API_KEY not configured');
  });
});
