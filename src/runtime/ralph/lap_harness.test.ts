/**
 * MHL.8 — the neutral resolver + SSOT set (T-multi-harness-lap). The kind→adapter resolver returns the shipped
 * adapters, throws (naming the implemented kinds) on an unresolved kind; LAP_HARNESS_KINDS is the SSOT set.
 * The envelope→outcome fold is proven in lap_outcome.test.ts (its home).
 */
import { describe, expect, it } from 'vitest';

import { LAP_HARNESS_KINDS, resolveLapHarness, type HarnessKind } from './lap_harness.js';

describe('resolveLapHarness (MHL.3)', () => {
  it('returns the adapter-owned Claude runner', () => {
    const h = resolveLapHarness('claude');
    expect(h.kind).toBe('claude');
    expect(typeof h.run).toBe('function');
    expect(typeof h.preflight).toBe('undefined');
  });

  it('returns the adapter-owned Codex runner with fail-loud preflight', () => {
    const h = resolveLapHarness('codex');
    expect(h.kind).toBe('codex');
    expect(typeof h.run).toBe('function');
    expect(typeof h.preflight).toBe('function');
  });

  it('throws naming the implemented kinds on an unresolved kind', () => {
    expect(() => resolveLapHarness('gemini' as HarnessKind)).toThrow(/no LapHarness adapter/i);
    expect(() => resolveLapHarness('gemini' as HarnessKind)).toThrow(/claude \| codex \| pi/);
  });

  it('LAP_HARNESS_KINDS is the SSOT set', () => {
    expect([...LAP_HARNESS_KINDS].sort()).toEqual(['claude', 'codex', 'pi']);
    expect(LAP_HARNESS_KINDS.has('claude')).toBe(true);
    expect(LAP_HARNESS_KINDS.has('codex')).toBe(true);
    expect(LAP_HARNESS_KINDS.has('pi')).toBe(true);
  });
});
