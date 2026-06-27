/** T2 — Safety policy loader: config IS the policy; fail-open to the default seed. */
import { rm, writeFile } from 'node:fs/promises';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_SAFETY_POLICY,
  loadSafetyPolicy,
  safetyPolicyPath,
  SafetyPolicy,
} from './safety_policy.js';

afterEach(async () => {
  await rm(safetyPolicyPath(), { force: true });
});

describe('loadSafetyPolicy (T2)', () => {
  it('absent config → the default seed (fail-open, never a throw)', async () => {
    await rm(safetyPolicyPath(), { force: true });
    expect(await loadSafetyPolicy()).toEqual(DEFAULT_SAFETY_POLICY);
  });

  it('a valid config file is read + parsed', async () => {
    const custom: SafetyPolicy = {
      forbid: [{ argPattern: 'shutdown', tier: 'hardline', message: 'no shutdowns' }],
      allow: [],
    };
    await writeFile(safetyPolicyPath(), JSON.stringify(custom));
    expect(await loadSafetyPolicy()).toEqual(custom);
  });

  it('a corrupt config → the default seed (fail-open)', async () => {
    await writeFile(safetyPolicyPath(), '{ not json');
    expect(await loadSafetyPolicy()).toEqual(DEFAULT_SAFETY_POLICY);
  });

  it('a config violating the schema (unknown key, strict) → the default seed', async () => {
    await writeFile(safetyPolicyPath(), JSON.stringify({ forbid: [], bogus: 1 }));
    expect(await loadSafetyPolicy()).toEqual(DEFAULT_SAFETY_POLICY);
  });

  it('the default seed itself parses (the shipped literal is a valid SafetyPolicy)', () => {
    expect(() => SafetyPolicy.parse(DEFAULT_SAFETY_POLICY)).not.toThrow();
  });
});
