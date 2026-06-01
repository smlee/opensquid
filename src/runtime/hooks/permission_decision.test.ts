/**
 * Tests for the PreToolUse deny envelope (T-RJ-FOLLOWUPS FU.11).
 *
 * The envelope (not a bare exit 2) is what survives `--dangerously-skip-permissions`
 * (= bypassPermissions). Verified live; these lock the shape.
 */

import { describe, expect, it } from 'vitest';

import { buildPreToolUseDeny } from './permission_decision.js';

describe('buildPreToolUseDeny', () => {
  it('builds a PreToolUse deny envelope carrying the reason', () => {
    expect(buildPreToolUseDeny('BLOCKED: 7-phase workflow incomplete')).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'BLOCKED: 7-phase workflow incomplete',
      },
    });
  });

  it('falls back to a generic reason when none is given', () => {
    expect(buildPreToolUseDeny('').hookSpecificOutput.permissionDecisionReason).toBe(
      'opensquid: blocked by a drift gate',
    );
  });
});
