/**
 * Tests for `models.yaml` schema.
 *
 * Coverage: empty record (minimum-viable), one-alias parse with defaults,
 * required-mode field, bad URL rejection.
 */

import { describe, expect, it } from 'vitest';

import { ModelsConfig } from './models.js';

describe('ModelsConfig schema', () => {
  it('parses an empty record (minimum-viable)', () => {
    const result = ModelsConfig.parse({});
    expect(result).toEqual({});
  });

  it('parses a subscription+cli alias with description/args defaults', () => {
    const result = ModelsConfig.parse({
      fast_classifier: {
        mode: 'subscription',
        impl: 'cli',
        cli: 'claude',
      },
    });
    expect(result.fast_classifier?.mode).toBe('subscription');
    expect(result.fast_classifier?.description).toBe('');
    expect(result.fast_classifier?.args).toEqual([]);
  });

  it('rejects a missing mode field', () => {
    const result = ModelsConfig.safeParse({ broken: {} });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('mode'))).toBe(true);
    }
  });

  it('rejects an invalid endpoint URL', () => {
    const result = ModelsConfig.safeParse({
      local: { mode: 'local', endpoint: 'not a url' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('endpoint'))).toBe(true);
    }
  });

  it('uses default empty record when undefined is passed', () => {
    const result = ModelsConfig.parse(undefined);
    expect(result).toEqual({});
  });
});
