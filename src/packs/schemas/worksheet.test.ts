/** T-scope-worksheet — Worksheet schema: mode invariants (single⇒1, batch⇒≥2+issue+permutation), .strict(). */
import { describe, expect, it } from 'vitest';

import { Worksheet } from './worksheet.js';

describe('Worksheet schema — single mode', () => {
  it('exactly 1 scope with order=[its id] → valid', () => {
    const r = Worksheet.safeParse({
      mode: 'single',
      scopes: [{ id: 'T-foo', summary: 'do foo' }],
      order: ['T-foo'],
    });
    expect(r.success).toBe(true);
  });

  it('2 scopes in single → invalid', () => {
    const r = Worksheet.safeParse({
      mode: 'single',
      scopes: [{ id: 'a', summary: 's' }, { id: 'b', summary: 's' }],
      order: ['a', 'b'],
    });
    expect(r.success).toBe(false);
  });

  it('single with order not covering its one scope → invalid', () => {
    const r = Worksheet.safeParse({ mode: 'single', scopes: [{ id: 'a', summary: 's' }], order: [] });
    expect(r.success).toBe(false);
  });
});

describe('Worksheet schema — batch mode', () => {
  const ok = {
    mode: 'batch' as const,
    parent: 'wg-1',
    scopes: [
      { id: 'a', issue: 'wg-a', summary: 'sa' },
      { id: 'b', issue: 'wg-b', summary: 'sb' },
    ],
    order: ['a', 'b'],
  };

  it('≥2 scopes, each with an issue, order = permutation → valid', () => {
    expect(Worksheet.safeParse(ok).success).toBe(true);
    expect(Worksheet.safeParse({ ...ok, order: ['b', 'a'] }).success).toBe(true); // any permutation
  });

  it('a batch scope WITHOUT an issue → invalid', () => {
    const r = Worksheet.safeParse({ ...ok, scopes: [{ id: 'a', issue: 'wg-a', summary: 'sa' }, { id: 'b', summary: 'sb' }] });
    expect(r.success).toBe(false);
  });

  it('order missing a scope id → invalid', () => {
    expect(Worksheet.safeParse({ ...ok, order: ['a', 'a'] }).success).toBe(false); // dup, misses b
    expect(Worksheet.safeParse({ ...ok, order: ['a'] }).success).toBe(false); // length mismatch
  });

  it('only 1 scope in batch → invalid', () => {
    const r = Worksheet.safeParse({ mode: 'batch', scopes: [{ id: 'a', issue: 'wg-a', summary: 's' }], order: ['a'] });
    expect(r.success).toBe(false);
  });
});

describe('Worksheet schema — strictness + defaults', () => {
  it('.strict() rejects an unknown key (e.g. typo modee)', () => {
    const r = Worksheet.safeParse({ modee: 'single', scopes: [{ id: 'a', summary: 's' }], order: ['a'] });
    expect(r.success).toBe(false);
  });

  it('mode defaults to single', () => {
    const r = Worksheet.safeParse({ scopes: [{ id: 'a', summary: 's' }], order: ['a'] });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.mode).toBe('single');
  });
});
