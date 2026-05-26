/**
 * Tests for `loadModelsConfig` — PR-followup three-source precedence resolver.
 *
 * Coverage:
 *   - empty (no arg, no env) → `{}`
 *   - pack-only path → pack aliases visible
 *   - env-only path (no arg) → env aliases visible (preserves Phase 1 contract)
 *   - env + pack → env wins for matching keys; pack contributes unique keys
 *   - invalid env JSON → falls back to pack (does not throw)
 *   - env non-object → falls back to pack
 *
 * `OPENSQUID_MODELS_CONFIG_INLINE` is the only env var consulted; tests
 * save + restore around each case to avoid cross-test leakage.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ModelsConfig } from '../packs/schemas/models.js';

import { loadModelsConfig } from './load_config.js';

const ENV_KEY = 'OPENSQUID_MODELS_CONFIG_INLINE';

describe('loadModelsConfig — three-source precedence (PR-followup)', () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = savedEnv;
    }
  });

  it('returns {} when no env var and no pack models', async () => {
    const cfg = await loadModelsConfig();
    expect(cfg).toEqual({});
  });

  it('returns pack-shipped aliases when only packModels is provided', async () => {
    const pack: ModelsConfig = {
      fast_classifier: {
        mode: 'subscription',
        impl: 'cli',
        cli: 'pack-cli',
        description: 'pack default',
        args: [],
      },
    };
    const cfg = await loadModelsConfig(pack);
    expect(cfg.fast_classifier?.cli).toBe('pack-cli');
    expect(cfg.fast_classifier?.mode).toBe('subscription');
  });

  it('preserves Phase 1 env-only contract (no packModels arg)', async () => {
    process.env[ENV_KEY] = JSON.stringify({
      env_only: { mode: 'subscription', impl: 'cli', cli: 'env-cli' },
    });
    const cfg = await loadModelsConfig();
    expect(cfg.env_only?.cli).toBe('env-cli');
  });

  it('env overrides pack for matching keys; pack contributes unique keys', async () => {
    const pack: ModelsConfig = {
      fast_classifier: {
        mode: 'subscription',
        impl: 'cli',
        cli: 'pack-cli',
        description: 'pack',
        args: [],
      },
      reasoning: {
        mode: 'subscription',
        impl: 'cli',
        cli: 'pack-reasoning',
        description: '',
        args: [],
      },
    };
    process.env[ENV_KEY] = JSON.stringify({
      fast_classifier: { mode: 'subscription', impl: 'cli', cli: 'env-override' },
    });
    const cfg = await loadModelsConfig(pack);
    // Env wins on key collision.
    expect(cfg.fast_classifier?.cli).toBe('env-override');
    // Pack contributes the key env didn't override.
    expect(cfg.reasoning?.cli).toBe('pack-reasoning');
  });

  it('invalid env JSON falls back to pack (does not throw)', async () => {
    process.env[ENV_KEY] = '{not valid json';
    const pack: ModelsConfig = {
      fast_classifier: {
        mode: 'subscription',
        impl: 'cli',
        cli: 'pack-cli',
        description: '',
        args: [],
      },
    };
    const cfg = await loadModelsConfig(pack);
    expect(cfg.fast_classifier?.cli).toBe('pack-cli');
  });

  it('env that parses to a non-object falls back to pack (no merge)', async () => {
    process.env[ENV_KEY] = '"a-bare-string"';
    const pack: ModelsConfig = {
      fast_classifier: {
        mode: 'subscription',
        impl: 'cli',
        cli: 'pack-cli',
        description: '',
        args: [],
      },
    };
    const cfg = await loadModelsConfig(pack);
    expect(cfg.fast_classifier?.cli).toBe('pack-cli');
  });

  it('does not mutate the input packModels map', async () => {
    const pack: ModelsConfig = {
      fast_classifier: {
        mode: 'subscription',
        impl: 'cli',
        cli: 'pack-cli',
        description: '',
        args: [],
      },
    };
    const snapshot = JSON.stringify(pack);
    process.env[ENV_KEY] = JSON.stringify({
      fast_classifier: { mode: 'subscription', impl: 'cli', cli: 'env-cli' },
    });
    await loadModelsConfig(pack);
    expect(JSON.stringify(pack)).toBe(snapshot);
  });
});
