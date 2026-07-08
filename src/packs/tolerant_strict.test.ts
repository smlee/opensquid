/**
 * CLR.2 — the CLR.1 `R-CLR-1` proof: the tolerant-strict seam contract, warn captured via the
 * injected sink (no global spy). Spec: docs/tasks/T-config-load-resilience.md §CLR.2 (wg-a02313251dfb).
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { parseTolerantStrict } from './tolerant_strict.js';

const S = z.object({ name: z.string(), version: z.string() }).strict();

describe('parseTolerantStrict — the tolerant-strict pack-config seam', () => {
  it('all-unknown-keys → warn (names the source + the key) + strip + return the valid value', () => {
    const warned: string[] = [];
    const out = parseTolerantStrict(
      S,
      { name: 'p', version: '1', future: true },
      'pack.yaml',
      (m) => warned.push(m),
    );
    expect(out).toEqual({ name: 'p', version: '1' }); // stripped, re-parsed clean
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('pack.yaml');
    expect(warned[0]).toContain("'future'"); // key NAMED, not silently dropped
  });

  it('names EVERY unknown key (multiple forward keys stripped in one warning)', () => {
    const warned: string[] = [];
    const out = parseTolerantStrict(
      S,
      { name: 'p', version: '1', future: true, legacy: 'x' },
      'pack.yaml',
      (m) => warned.push(m),
    );
    expect(out).toEqual({ name: 'p', version: '1' });
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("'future'");
    expect(warned[0]).toContain("'legacy'");
  });

  it('a valid value with no unknown keys passes through untouched (no warning)', () => {
    const warned: string[] = [];
    const out = parseTolerantStrict(S, { name: 'p', version: '1' }, 'x', (m) => warned.push(m));
    expect(out).toEqual({ name: 'p', version: '1' });
    expect(warned).toHaveLength(0);
  });

  it('a genuine error (missing required) re-throws the original ZodError — fail-loud preserved', () => {
    const warned: string[] = [];
    expect(() => parseTolerantStrict(S, { name: 'p' }, 'pack.yaml', (m) => warned.push(m))).toThrow(
      z.ZodError,
    ); // no version → not all-unknown
    expect(warned).toHaveLength(0); // never warns on a genuine error
  });

  it('a genuine error (wrong type) re-throws (not softened)', () => {
    expect(() => parseTolerantStrict(S, { name: 1, version: '1' }, 'x', () => undefined)).toThrow();
  });

  it('a MIX of unknown + genuine issues re-throws (not softened to warn)', () => {
    const warned: string[] = [];
    expect(() =>
      parseTolerantStrict(S, { name: 'p', extra: 1 }, 'x', (m) => warned.push(m)),
    ).toThrow(); // missing version + unknown key → not all-unrecognized
    expect(warned).toHaveLength(0);
  });

  it('strips unknown keys in a NESTED .strict() object at the issue path', () => {
    const nested = z
      .object({ name: z.string(), opts: z.object({ a: z.string() }).strict() })
      .strict();
    const warned: string[] = [];
    const out = parseTolerantStrict(
      nested,
      { name: 'p', opts: { a: 'x', b: 'unknown' } },
      'pack.yaml',
      (m) => warned.push(m),
    );
    expect(out).toEqual({ name: 'p', opts: { a: 'x' } });
    expect(warned[0]).toContain("'b'");
  });

  it('does not mutate the caller-provided raw value while stripping', () => {
    const raw = { name: 'p', version: '1', future: true };
    parseTolerantStrict(S, raw, 'x', () => undefined);
    expect(raw).toHaveProperty('future', true); // original untouched — strip works on a clone
  });
});
