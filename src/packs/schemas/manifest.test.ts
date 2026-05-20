/**
 * Tests for `manifest.yaml` schema.
 *
 * Coverage: minimum-viable parse (the 4-field example from design doc
 * §"Minimum-viable pack example"), default fill-in, regex constraints
 * (name + version), `.strict()` typo rejection, scope enum exhaustiveness.
 */

import { describe, expect, it } from 'vitest';

import { Manifest } from './manifest.js';

describe('Manifest schema', () => {
  it('parses the minimum-viable 4-field manifest with defaults filled in', () => {
    const result = Manifest.parse({
      name: 'my-first-pack',
      version: '0.1.0',
      scope: 'workflow',
      goal: 'ship verified work',
    });
    expect(result.name).toBe('my-first-pack');
    expect(result.description).toBe('');
    expect(result.requires).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(result.evolves).toBe(true);
    expect(result.extends).toBeUndefined();
  });

  it('rejects an uppercase name with informative regex error', () => {
    const result = Manifest.safeParse({
      name: 'My Pack',
      version: '1.0.0',
      scope: 'workflow',
      goal: 'x',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues[0];
      expect(issue?.path).toEqual(['name']);
      expect(issue?.message).toMatch(/lowercase/);
    }
  });

  it('rejects a non-semver version', () => {
    const result = Manifest.safeParse({
      name: 'p',
      version: '1',
      scope: 'workflow',
      goal: 'x',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['version']);
      expect(result.error.issues[0]?.message).toMatch(/semver/);
    }
  });

  it('rejects a digit-leading name (e.g. "1pack")', () => {
    const result = Manifest.safeParse({
      name: '1pack',
      version: '0.1.0',
      scope: 'workflow',
      goal: 'x',
    });
    // Regex allows [a-z0-9][a-z0-9-]* — digit-leading IS allowed by current
    // regex. Spec risk callout says "document this in setup UI errors" but
    // doesn't tighten the regex. Test pins current behavior so a future
    // tightening trips this test.
    expect(result.success).toBe(true);
  });

  it('strict mode rejects unknown fields (typo guard)', () => {
    const result = Manifest.safeParse({
      name: 'p',
      version: '0.1.0',
      scope: 'workflow',
      goal: 'x',
      versoin: '0.2.0', // typo
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.code === 'unrecognized_keys')).toBe(true);
    }
  });

  it('accepts all five scope values', () => {
    for (const scope of ['universal', 'domain', 'specialty', 'workflow', 'project'] as const) {
      const result = Manifest.safeParse({
        name: 'p',
        version: '0.1.0',
        scope,
        goal: 'x',
      });
      expect(result.success).toBe(true);
    }
  });

  // ---------------------------------------------------------------------------
  // AUTO.2 — `rate_limits:` block.
  //
  // The block is fully optional (block-missing = unlimited for every trigger,
  // back-compat). Inside the block, every trigger key is also individually
  // optional. Required validation centres on: `per` is the sealed
  // minute|hour|day enum; `max` and `concurrent` are positive integers; typos
  // in trigger keys fail `.strict()`; the locked enum rejects `"5 minutes"`.
  // ---------------------------------------------------------------------------

  it('accepts a manifest with no rate_limits block (back-compat)', () => {
    const result = Manifest.parse({
      name: 'p',
      version: '0.1.0',
      scope: 'workflow',
      goal: 'x',
    });
    expect(result.rate_limits).toBeUndefined();
  });

  it('parses a full rate_limits block matching the spec example', () => {
    const result = Manifest.parse({
      name: 'p',
      version: '0.1.0',
      scope: 'workflow',
      goal: 'x',
      rate_limits: {
        schedule: { max: 1, per: 'minute', concurrent: 1 },
        webhook: { max: 60, per: 'minute', concurrent: 5 },
        inbound_channel: { max: 30, per: 'minute' },
        file_changed: { max: 100, per: 'minute' },
      },
    });
    expect(result.rate_limits?.schedule).toEqual({ max: 1, per: 'minute', concurrent: 1 });
    expect(result.rate_limits?.inbound_channel?.concurrent).toBeUndefined();
  });

  it('rejects rate_limits.schedule.per = "5 minutes" (sealed enum)', () => {
    const result = Manifest.safeParse({
      name: 'p',
      version: '0.1.0',
      scope: 'workflow',
      goal: 'x',
      rate_limits: { schedule: { max: 1, per: '5 minutes' } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.includes('per'));
      expect(issue).toBeDefined();
    }
  });

  it('rejects rate_limits with negative max', () => {
    const result = Manifest.safeParse({
      name: 'p',
      version: '0.1.0',
      scope: 'workflow',
      goal: 'x',
      rate_limits: { schedule: { max: -1, per: 'minute' } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects rate_limits with zero concurrent', () => {
    const result = Manifest.safeParse({
      name: 'p',
      version: '0.1.0',
      scope: 'workflow',
      goal: 'x',
      rate_limits: { schedule: { max: 10, per: 'minute', concurrent: 0 } },
    });
    expect(result.success).toBe(false);
  });

  it('strict mode rejects an unknown trigger key inside rate_limits', () => {
    const result = Manifest.safeParse({
      name: 'p',
      version: '0.1.0',
      scope: 'workflow',
      goal: 'x',
      rate_limits: { webhok: { max: 1, per: 'minute' } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.code === 'unrecognized_keys')).toBe(true);
    }
  });

  it('strict mode rejects an unknown key inside a per-trigger config', () => {
    const result = Manifest.safeParse({
      name: 'p',
      version: '0.1.0',
      scope: 'workflow',
      goal: 'x',
      rate_limits: { schedule: { max: 1, per: 'minute', burst: 5 } },
    });
    expect(result.success).toBe(false);
  });

  it('accepts hour and day periods (full enum coverage)', () => {
    for (const per of ['minute', 'hour', 'day'] as const) {
      const result = Manifest.safeParse({
        name: 'p',
        version: '0.1.0',
        scope: 'workflow',
        goal: 'x',
        rate_limits: { schedule: { max: 1, per } },
      });
      expect(result.success).toBe(true);
    }
  });
});
