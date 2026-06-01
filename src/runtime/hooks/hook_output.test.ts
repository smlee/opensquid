/**
 * Tests for hook-output helpers (T-RJ-FOLLOWUPS FU.11 + the 🦑 drift marker).
 */

import { describe, expect, it } from 'vitest';

import { buildPreToolUseDeny, squidPrefix } from './hook_output.js';

describe('squidPrefix', () => {
  it('prefixes a drift message with the squid marker', () => {
    expect(squidPrefix('BLOCKED: do the thing')).toBe('🦑 BLOCKED: do the thing');
  });

  it('is idempotent (never double-prefixes)', () => {
    expect(squidPrefix('🦑 already marked')).toBe('🦑 already marked');
  });

  it('passes an empty string through untouched (nothing to surface)', () => {
    expect(squidPrefix('')).toBe('');
  });
});

describe('buildPreToolUseDeny', () => {
  it('builds a squid-prefixed PreToolUse deny envelope carrying the reason', () => {
    expect(buildPreToolUseDeny('BLOCKED: 7-phase workflow incomplete')).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: '🦑 BLOCKED: 7-phase workflow incomplete',
      },
    });
  });

  it('falls back to a generic (squid-prefixed) reason when none is given', () => {
    expect(buildPreToolUseDeny('').hookSpecificOutput.permissionDecisionReason).toBe(
      '🦑 opensquid: blocked by a drift gate',
    );
  });

  it('FC.2: appends the forward-map guidance beneath the reason when provided', () => {
    const r = buildPreToolUseDeny('BLOCKED: x', 'You are at: scoping\nNext: write the doc');
    expect(r.hookSpecificOutput.permissionDecisionReason).toBe(
      '🦑 BLOCKED: x\n\nYou are at: scoping\nNext: write the doc',
    );
  });

  it('omits the guidance block cleanly when none/empty', () => {
    expect(buildPreToolUseDeny('BLOCKED: x').hookSpecificOutput.permissionDecisionReason).toBe(
      '🦑 BLOCKED: x',
    );
    expect(buildPreToolUseDeny('BLOCKED: x', '').hookSpecificOutput.permissionDecisionReason).toBe(
      '🦑 BLOCKED: x',
    );
  });
});
