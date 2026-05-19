/**
 * Tests for `notifications.yaml` schema.
 *
 * Coverage: empty config defaults, strict-mode typo rejection, per-project
 * override, invalid severity rejection.
 */

import { describe, expect, it } from 'vitest';

import { NotificationsConfig } from './notifications.js';

describe('NotificationsConfig schema', () => {
  it('parses an empty object with documented defaults', () => {
    const result = NotificationsConfig.parse({});
    expect(result.severity_tiers.critical).toEqual(['alerts']);
    expect(result.severity_tiers.warning).toEqual(['chat']);
    expect(result.per_project_override).toEqual({});
  });

  it('parses a per-project override', () => {
    const result = NotificationsConfig.parse({
      severity_tiers: {
        critical: ['alerts'],
      },
      per_project_override: {
        opensquid: { warning: ['chat', 'opensquid_topic'] },
      },
    });
    expect(result.per_project_override.opensquid?.warning).toEqual(['chat', 'opensquid_topic']);
  });

  it('rejects an unknown top-level key (strict mode)', () => {
    const result = NotificationsConfig.safeParse({ severity_tier: {} });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.code === 'unrecognized_keys')).toBe(true);
    }
  });

  it('rejects an invalid severity name', () => {
    const result = NotificationsConfig.safeParse({
      severity_tiers: { fatal: ['alerts'] },
    });
    expect(result.success).toBe(false);
  });
});
