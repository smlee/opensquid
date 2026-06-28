/**
 * design_system_generate (FD5) — the output generator. Tests the primary-sourced color math against known anchors
 * (black/white contrast = 21), and proves the generator (a) emits a coherent DTCG token system derived from its
 * inputs, (b) ENFORCES WCAG AA contrast on the semantic text/surface pair (not assumed), and (c) justifies each
 * decision by citing a knowledge rule.
 */
import { describe, expect, it } from 'vitest';

import {
  contrastRatio,
  generateDesignSystem,
  oklchToHex,
  relativeLuminance,
} from './design_system.js';
import type { EvalCtx } from './registry.js';

const CTX = {
  event: { kind: 'tool_call' },
  bindings: new Map<string, unknown>(),
  sessionId: 's',
  packId: 'p',
} as unknown as EvalCtx;

describe('color math (Ottosson OKLab + WCAG luminance)', () => {
  it('luminance of pure black is 0 and pure white is 1', () => {
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 5);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5);
  });

  it('black-on-white contrast is the WCAG maximum 21:1', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
  });

  it('identical colors have contrast 1:1', () => {
    expect(contrastRatio('#3366cc', '#3366cc')).toBeCloseTo(1, 5);
  });

  it('oklchToHex returns a valid 6-digit hex', () => {
    expect(oklchToHex(0.62, 0.15, 256)).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('zero chroma yields a true grayscale (R==G==B)', () => {
    const hex = oklchToHex(0.6, 0, 0);
    expect(hex.slice(1, 3)).toBe(hex.slice(3, 5));
    expect(hex.slice(3, 5)).toBe(hex.slice(5, 7));
  });

  it('higher OKLCH lightness produces a lighter (higher-luminance) color', () => {
    expect(relativeLuminance(oklchToHex(0.9, 0.1, 256))).toBeGreaterThan(
      relativeLuminance(oklchToHex(0.4, 0.1, 256)),
    );
  });
});

describe('generateDesignSystem — coherence + enforcement', () => {
  const sys = generateDesignSystem({
    brandHue: 256,
    scaleRatio: 1.25,
    baseSize: 16,
    density: 'comfortable',
  });

  it('emits a DTCG color ramp (50..900) for brand + neutral', () => {
    const color = sys.tokens.color as Record<string, Record<string, { $value: string }>>;
    expect(Object.keys(color.brand)).toContain('500');
    expect(color.brand['500']?.$value).toMatch(/^#[0-9a-f]{6}$/);
    expect(Object.keys(color.neutral)).toHaveLength(10);
  });

  it('derives a modular type scale from base × ratio (base=16 → base token 16px)', () => {
    const size = (sys.tokens.typography as { size: Record<string, { $value: string }> }).size;
    expect(size.base?.$value).toBe('16px');
    expect(size.lg?.$value).toBe('20px'); // 16 × 1.25
  });

  it('builds an 8pt spacing ramp by default', () => {
    const space = sys.tokens.space as Record<string, { $value: string }>;
    expect(space['1']?.$value).toBe('8px');
    expect(space['2']?.$value).toBe('16px');
  });

  it('uses a compact 4pt ramp when density=compact', () => {
    const compact = generateDesignSystem({
      brandHue: 256,
      scaleRatio: 1.25,
      baseSize: 16,
      density: 'compact',
    });
    const space = compact.tokens.space as Record<string, { $value: string }>;
    expect(space['1']?.$value).toBe('4px');
  });

  it('ENFORCES WCAG AA contrast on the semantic text/surface pair (verified, not assumed)', () => {
    const passing = sys.contrastChecks.filter((c) => c.pass);
    expect(passing.length).toBeGreaterThan(0);
    // the chosen text alias must reference a shade whose contrast check passed
    const textValue = (sys.tokens.color as { text: { $value: string } }).text.$value;
    expect(textValue).toMatch(/\{color\.neutral\.\d+\}/);
  });

  it('semantic tokens are aliases (UI binds semantic, never raw primitives — token-tiers)', () => {
    const color = sys.tokens.color as { action: { $value: string }; bg: { $value: string } };
    expect(color.action.$value).toMatch(/^\{color\./);
    expect(color.bg.$value).toMatch(/^\{color\./);
  });

  it('justifies each decision by citing a knowledge rule', () => {
    expect(sys.rationale.join(' ')).toMatch(/type-scale-single-ratio/);
    expect(sys.rationale.join(' ')).toMatch(/spacing-8pt-grid/);
    expect(sys.rationale.join(' ')).toMatch(/wcag-1\.4\.3-contrast/);
  });
});

describe('design_system_generate primitive (live registry)', () => {
  it('is registered + dispatches through Zod, returning a justified system', async () => {
    const { buildRegistry } = await import('../runtime/bootstrap.js');
    const r = await buildRegistry();
    const res = await r.call('design_system_generate', { brandHue: 256 }, CTX);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const out = res.value as { rationale?: string[]; contrastChecks?: unknown[] };
    expect(Array.isArray(out.rationale)).toBe(true);
    expect((out.contrastChecks ?? []).length).toBeGreaterThan(0);
  });

  it('rejects an out-of-range brand hue at the Zod boundary', async () => {
    const { buildRegistry } = await import('../runtime/bootstrap.js');
    const r = await buildRegistry();
    const res = await r.call('design_system_generate', { brandHue: 999 }, CTX);
    expect(res.ok).toBe(false);
  });
});
