import { describe, expect, it } from 'vitest';

import { automationEnforcing, reportResolved } from './report_resolution.js';

describe('automationEnforcing', () => {
  it('is true only when OPENSQUID_AUTOMATION === "1"', () => {
    expect(automationEnforcing({ OPENSQUID_AUTOMATION: '1' })).toBe(true);
  });

  it('is false when unset', () => {
    expect(automationEnforcing({})).toBe(false);
  });

  it('is false for any other value', () => {
    expect(automationEnforcing({ OPENSQUID_AUTOMATION: '0' })).toBe(false);
    expect(automationEnforcing({ OPENSQUID_AUTOMATION: 'true' })).toBe(false);
    expect(automationEnforcing({ OPENSQUID_AUTOMATION: '' })).toBe(false);
  });
});

describe('reportResolved', () => {
  const enforcing = { OPENSQUID_AUTOMATION: '1' };
  const interactive = {};

  it('HOLDS the gate when enforcing and an item is unresolved', () => {
    expect(reportResolved(false, enforcing)).toBe(false);
  });

  it('passes when enforcing and all items are resolved', () => {
    expect(reportResolved(true, enforcing)).toBe(true);
  });

  it('never blocks interactively even when unresolved', () => {
    expect(reportResolved(false, interactive)).toBe(true);
  });

  it('passes interactively when all items are resolved', () => {
    expect(reportResolved(true, interactive)).toBe(true);
  });
});
