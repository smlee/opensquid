/**
 * MHL.8 — the neutral resolver + SSOT set (T-multi-harness-lap). The kind→adapter resolver returns the shipped
 * adapters, throws (naming the implemented kinds) on an unresolved kind; LAP_HARNESS_KINDS is the SSOT set.
 * The envelope→outcome fold is proven in lap_outcome.test.ts (its home).
 */
import { describe, expect, it } from 'vitest';

import { LAP_HARNESS_KINDS, resolveLapHarness, type HarnessKind } from './lap_harness.js';

describe('resolveLapHarness (MHL.3)', () => {
  it('returns the claude adapter (spawnArgs/deliverPrompt/parseEnvelope) for kind:claude', () => {
    const h = resolveLapHarness('claude');
    expect(typeof h.spawnArgs).toBe('function');
    expect(typeof h.deliverPrompt).toBe('function');
    expect(typeof h.parseEnvelope).toBe('function');
    // Claude omits the optional preflight.
    expect(typeof h.preflight).toBe('undefined');
  });

  it('returns the codex adapter (with a fail-loud preflight) for kind:codex', () => {
    const h = resolveLapHarness('codex');
    expect(typeof h.spawnArgs).toBe('function');
    expect(typeof h.deliverPrompt).toBe('function');
    expect(typeof h.parseEnvelope).toBe('function');
    expect(typeof h.preflight).toBe('function'); // Codex implements the auth preflight
  });

  it('throws naming the implemented kinds on an unresolved kind', () => {
    expect(() => resolveLapHarness('gemini' as HarnessKind)).toThrow(/no LapHarness adapter/i);
    expect(() => resolveLapHarness('gemini' as HarnessKind)).toThrow(/claude \| codex/);
  });

  it('LAP_HARNESS_KINDS is the SSOT set {claude, codex}', () => {
    expect([...LAP_HARNESS_KINDS].sort()).toEqual(['claude', 'codex']);
    expect(LAP_HARNESS_KINDS.has('claude')).toBe(true);
    expect(LAP_HARNESS_KINDS.has('codex')).toBe(true);
  });
});
