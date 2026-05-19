/**
 * Tests for `drift_response.yaml` schema.
 *
 * Coverage: empty parse with default policy, per-rule overrides, all six
 * policy enum values accepted, invalid policy rejection, strict-mode typo
 * rejection.
 */

import { describe, expect, it } from 'vitest';

import { DriftResponseConfig } from './drift_response.js';

describe('DriftResponseConfig schema', () => {
  it('parses an empty object with default = block_tool', () => {
    const result = DriftResponseConfig.parse({});
    expect(result.default).toBe('block_tool');
    expect(result.per_rule).toEqual({});
  });

  it('parses per-rule overrides', () => {
    const result = DriftResponseConfig.parse({
      default: 'full_stop_and_redo',
      per_rule: {
        'never-amend': 'block_tool',
        'workflow-phases': 'full_stop_and_redo',
      },
    });
    expect(result.default).toBe('full_stop_and_redo');
    expect(result.per_rule['never-amend']).toBe('block_tool');
  });

  it('accepts all six policy values (incl. deferred auto_correct + escalate)', () => {
    const policies = [
      'block_tool',
      'warn',
      'full_stop_and_redo',
      'notify_and_pause',
      'auto_correct',
      'escalate',
    ] as const;
    for (const p of policies) {
      const result = DriftResponseConfig.safeParse({ default: p });
      expect(result.success).toBe(true);
    }
  });

  it('rejects an unknown policy string', () => {
    const result = DriftResponseConfig.safeParse({ default: 'panic' });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown top-level key (strict mode)', () => {
    const result = DriftResponseConfig.safeParse({ defualt: 'warn' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.code === 'unrecognized_keys')).toBe(true);
    }
  });
});
