/** AGF.1 (wg-01d5a9233026) — the PURE locked-prefix next-tag computer: patchOfTag / nextLockedTag / nextRcTag.
 *  No git, no I/O. The load-bearing regression: an OFF-prefix tag (v0.7.2 with prefix 0.5) does NOT parse → seed
 *  <prefix>.0, NOT the off-prefix patch+1 (what a naive lastReleaseTag reuse would get wrong). */
import { describe, it, expect } from 'vitest';
import { patchOfTag, nextLockedTag, nextRcTag } from './locked_version.js';

const cfg = { strategy: 'locked-prefix', prefix: '0.5', bump: 'patch-per-release' } as const;

describe('AGF.1 patchOfTag', () => {
  it('parses the patch for the declared prefix (leading v optional), escaping the dots', () => {
    expect(patchOfTag('v0.5.7', '0.5')).toBe(7);
    expect(patchOfTag('0.5.7', '0.5')).toBe(7);
    expect(patchOfTag('v0.5.548', '0.5')).toBe(548);
  });
  it('returns null for an off-prefix tag and rejects the dot-as-wildcard match', () => {
    expect(patchOfTag('v0.7.2', '0.5')).toBeNull();
    expect(patchOfTag('v0X5X7', '0.5')).toBeNull(); // the dots are literal, not wildcards
  });
});

describe('AGF.1 nextLockedTag — patch-per-release, prefix human-held, NEVER intent-from-commit', () => {
  it('bumps the patch off the highest prefix tag', () => {
    expect(nextLockedTag(cfg, 'v0.5.547')).toBe('0.5.548');
    expect(nextLockedTag(cfg, 'v0.5.0')).toBe('0.5.1');
  });
  it('seeds <prefix>.0 when the prefix has no tag yet (null)', () => {
    expect(nextLockedTag(cfg, null)).toBe('0.5.0');
  });
  it('THE off-prefix regression: v0.7.2 present + prefix 0.5 → 0.5.0 (never 0.7.3)', () => {
    expect(nextLockedTag(cfg, 'v0.7.2')).toBe('0.5.0');
  });
});

describe('AGF.1 nextRcTag — single-writer rc counter on the one stage branch', () => {
  it('first rc of a base → -rc.1', () => {
    expect(nextRcTag(cfg, 'v0.5.10', [])).toBe('0.5.11-rc.1');
  });
  it('advances past the highest existing rc for that base', () => {
    expect(nextRcTag(cfg, 'v0.5.10', ['v0.5.11-rc.1', 'v0.5.11-rc.2'])).toBe('0.5.11-rc.3');
  });
  it('ignores rc tags for a DIFFERENT base', () => {
    expect(nextRcTag(cfg, 'v0.5.10', ['v0.5.99-rc.5'])).toBe('0.5.11-rc.1');
  });
});
