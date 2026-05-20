/**
 * Tests for api_openai strategy. Mirrors api_anthropic.test.ts shape.
 *   1. happy path → text returned
 *   2. 429 then 200 → retry succeeds (fake timers)
 *   3. missing API key → throw
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SecretResolver } from '../../secrets/types.js';
import type { ModelAliasConfig } from '../types.js';

import { apiOpenAIStrategy, type OpenAISdkModule, type OpenAIChatResponse } from './api_openai.js';

const cfg: ModelAliasConfig = {
  mode: 'api',
  provider: 'openai',
  model: 'user-supplied-model-id',
};

function makeSecrets(map: Record<string, string | null>): SecretResolver {
  return {
    resolve: (uri: string) => Promise.resolve(map[uri] ?? null),
  };
}

function makeSdkModule(handler: (call: number) => Promise<OpenAIChatResponse>): {
  module: OpenAISdkModule;
  callCount: () => number;
} {
  let calls = 0;
  const module: OpenAISdkModule = {
    default: class {
      constructor(_opts: { apiKey: string }) {
        // no-op
      }
      chat = {
        completions: {
          create: () => {
            calls += 1;
            return handler(calls);
          },
        },
      };
    },
  };
  return { module, callCount: () => calls };
}

describe('apiOpenAIStrategy', () => {
  it('returns text on happy path', async () => {
    const secrets = makeSecrets({ 'env:OPENAI_API_KEY': 'sk-test' });
    const { module } = makeSdkModule(() =>
      Promise.resolve({ choices: [{ message: { content: 'hello' } }] }),
    );
    const strat = apiOpenAIStrategy(cfg, secrets, { sdkModule: module });
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
      const secrets = makeSecrets({ 'env:OPENAI_API_KEY': 'sk-test' });
      const { module, callCount } = makeSdkModule((call) => {
        if (call === 1) {
          const err = Object.assign(new Error('rate'), { status: 429 });
          return Promise.reject(err);
        }
        return Promise.resolve({ choices: [{ message: { content: 'recovered' } }] });
      });
      const strat = apiOpenAIStrategy(cfg, secrets, { sdkModule: module });
      const promise = strat.call('hi');
      await vi.advanceTimersByTimeAsync(1000);
      const out = await promise;
      expect(out).toBe('recovered');
      expect(callCount()).toBe(2);
    });
  });

  it('throws when OPENAI_API_KEY is not configured', async () => {
    const secrets = makeSecrets({});
    const { module } = makeSdkModule(() =>
      Promise.resolve({ choices: [{ message: { content: 'unused' } }] }),
    );
    const strat = apiOpenAIStrategy(cfg, secrets, { sdkModule: module });
    await expect(strat.call('hi')).rejects.toThrow('OPENAI_API_KEY not configured');
  });
});
