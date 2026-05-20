/**
 * Tests for local_ollama strategy.
 *   1. stubbed fetch returns response → ok
 *   2. non-200 → throw with status + body
 *   3. default endpoint used when cfg.endpoint omitted (localhost:11434)
 */

import { describe, expect, it } from 'vitest';

import type { ModelAliasConfig } from '../types.js';

import { localOllamaStrategy } from './local_ollama.js';

function makeFetch(handler: (url: string, init?: RequestInit) => Response): {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  lastUrl: () => string | undefined;
} {
  let lastUrl: string | undefined;
  return {
    fetch: (input, init) => {
      lastUrl = input;
      return Promise.resolve(handler(input, init));
    },
    lastUrl: () => lastUrl,
  };
}

describe('localOllamaStrategy', () => {
  it('returns the response field from a 200 OK', async () => {
    const cfg: ModelAliasConfig = {
      mode: 'local',
      model: 'user-supplied-model-id',
      endpoint: 'http://ollama.example:11434',
    };
    const { fetch } = makeFetch(
      () =>
        new Response(JSON.stringify({ response: 'hello' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const strat = localOllamaStrategy(cfg, { fetch });
    const out = await strat.call('hi');
    expect(out).toBe('hello');
  });

  it('throws on non-200 with status + body', async () => {
    const cfg: ModelAliasConfig = {
      mode: 'local',
      model: 'user-supplied-model-id',
    };
    const { fetch } = makeFetch(() => new Response('server boom', { status: 500 }));
    const strat = localOllamaStrategy(cfg, { fetch });
    await expect(strat.call('hi')).rejects.toThrow(/Ollama 500: server boom/);
  });

  it('uses default endpoint http://localhost:11434 when cfg.endpoint is omitted', async () => {
    const cfg: ModelAliasConfig = {
      mode: 'local',
      model: 'user-supplied-model-id',
    };
    const { fetch, lastUrl } = makeFetch(
      () => new Response(JSON.stringify({ response: 'ok' }), { status: 200 }),
    );
    const strat = localOllamaStrategy(cfg, { fetch });
    await strat.call('hi');
    expect(lastUrl()).toBe('http://localhost:11434/api/generate');
  });
});
