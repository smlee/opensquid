import { describe, expect, it } from 'vitest';

import { resolveStrategy } from './dispatcher.js';

import type { ModelAliasConfig } from './types.js';

describe('resolveStrategy output-bound admission', () => {
  it('rejects a byte-bounded call before invoking a strategy without capture enforcement', async () => {
    const config: ModelAliasConfig = {
      mode: 'subscription',
      impl: 'sdk',
      sdk: 'definitely-not-installed',
    };
    const strategy = resolveStrategy('unbounded-sdk', config);
    await expect(strategy.call('prompt', { maxOutputBytes: 1 })).rejects.toThrow(
      'does not support capture-bounded output',
    );
  });
});
