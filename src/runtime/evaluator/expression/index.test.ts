/**
 * End-to-end tests for the public `evalCondition` driver — Task H.1.6.
 *
 * Covers:
 *   - The pre-research §7.1/§7.2 regression matrix (12 cases) at the public-
 *     entry layer so we have a parallel suite that doesn't depend on the
 *     `evaluateProcess` orchestration around `evalCondition` (the existing
 *     `evaluator.test.ts` covers the orchestrated path).
 *   - The new-form forms enabled by chevrotain (§7.5): `||`, `!`, parens,
 *     deeper paths, `phases != "complete"` (the §12.4 latent fix).
 *   - Locked behavior changes: §12.2 (empty `if:` → `true`), §12.3 (strict
 *     equality — `1 == "1"` is `false`).
 *   - Error-tier coverage: lex / parse / AST / interpreter-limit / runtime
 *     errors all fail-closed to `false + warn`.
 *   - Cache integration: same expression evaluated twice → second call hits
 *     cache (size increments by 1 not 2).
 *   - `parseExpression()` parse-only entry: round-trips a few expressions
 *     and throws on the empty + invalid cases (H.2 will lean on this).
 *
 * Cache is cleared in `beforeEach` so size assertions are deterministic.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { toPolicyToolValue } from '../../../integrations/pi/tool_aliases.js';
import { clear, stats } from './cache.js';

import { evalCondition, parseExpression } from './index.js';

describe('evalCondition — regression matrix (pre-research §7.1)', () => {
  beforeEach(() => clear());

  it('case 1 — bare truthy: `hit` with hit=true → true', () => {
    const b = new Map<string, unknown>([['hit', true]]);
    expect(evalCondition('hit', b)).toBe(true);
  });

  it('case 2 — bare falsy: `hit` with hit=false → false', () => {
    const b = new Map<string, unknown>([['hit', false]]);
    expect(evalCondition('hit', b)).toBe(false);
  });

  it('case 3 — EQ match: `x == "FOO"` with x="FOO" → true', () => {
    const b = new Map<string, unknown>([['x', 'FOO']]);
    expect(evalCondition('x == "FOO"', b)).toBe(true);
  });

  it('case 4 — EQ miss: `x == "BAR"` with x="FOO" → false', () => {
    const b = new Map<string, unknown>([['x', 'FOO']]);
    expect(evalCondition('x == "BAR"', b)).toBe(false);
  });

  it('case 5 — unsupported (lex error): `== =` → false + warn', () => {
    // The bare `=` after `==` is not a recognised token (only `==` / `===` /
    // `!=` / `!==` are valid `=`-bearing tokens). The lex layer rejects it.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(evalCondition('== =', new Map())).toBe(false);
      const lexWarns = warn.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('lex error'),
      );
      expect(lexWarns.length).toBeGreaterThanOrEqual(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('case 6 — NUM array length: `matches.length > 0` with 2 elements → true', () => {
    const b = new Map<string, unknown>([['matches', ['x', 'y']]]);
    expect(evalCondition('matches.length > 0', b)).toBe(true);
  });

  it('case 7 — NUM empty array: `matches.length > 0` with [] → false', () => {
    const b = new Map<string, unknown>([['matches', []]]);
    expect(evalCondition('matches.length > 0', b)).toBe(false);
  });

  it('case 8 — NUM object field: `tools.count === 0` with count=0 → true', () => {
    const b = new Map<string, unknown>([['tools', { count: 0 }]]);
    expect(evalCondition('tools.count === 0', b)).toBe(true);
  });

  it('case 9 — NUM nested 3-deep: `drift.matched.length > 0` → true', () => {
    const b = new Map<string, unknown>([['drift', { matched: ['x', 'y'] }]]);
    expect(evalCondition('drift.matched.length > 0', b)).toBe(true);
  });

  it('case 10 — AND compound true: both halves true → true', () => {
    const b = new Map<string, unknown>([
      ['drift_phrases', { matched: ['per memory'] }],
      ['verification_tools', { count: 0 }],
    ]);
    const expr = 'drift_phrases.matched.length > 0 && verification_tools.count === 0';
    expect(evalCondition(expr, b)).toBe(true);
  });

  it('case 11 — AND short-circuit LHS false → false', () => {
    const b = new Map<string, unknown>([
      ['drift_phrases', { matched: [] }],
      ['verification_tools', { count: 0 }],
    ]);
    const expr = 'drift_phrases.matched.length > 0 && verification_tools.count === 0';
    expect(evalCondition(expr, b)).toBe(false);
  });

  it('case 12 — AND short-circuit RHS false → false', () => {
    const b = new Map<string, unknown>([
      ['drift_phrases', { matched: ['per memory'] }],
      ['verification_tools', { count: 1 }],
    ]);
    const expr = 'drift_phrases.matched.length > 0 && verification_tools.count === 0';
    expect(evalCondition(expr, b)).toBe(false);
  });
});

describe('evalCondition — locked behavior changes (pre-research §12.2 / §12.3)', () => {
  beforeEach(() => clear());

  it('§12.2 — empty string returns true (was silent-false pre-H.1.6)', () => {
    expect(evalCondition('', new Map())).toBe(true);
  });

  it('§12.2 — whitespace-only trims to empty and returns true', () => {
    expect(evalCondition('   \t  \n  ', new Map())).toBe(true);
  });

  it('§12.3 — strict equality: 1 == "1" is false (no String() coercion)', () => {
    const b = new Map<string, unknown>([['n', 1]]);
    expect(evalCondition('n == "1"', b)).toBe(false);
  });

  it('§12.3 — strict equality: numeric == numeric still works', () => {
    const b = new Map<string, unknown>([['n', 5]]);
    expect(evalCondition('n == 5', b)).toBe(true);
  });
});

describe('evalCondition — new grammar forms (pre-research §7.5)', () => {
  beforeEach(() => clear());

  it('§12.4 — `phases != "complete"` fires when phases is different', () => {
    const b = new Map<string, unknown>([['phases', 'partial']]);
    expect(evalCondition('phases != "complete"', b)).toBe(true);
  });

  it('§12.4 — `phases != "complete"` is false when phases is complete', () => {
    const b = new Map<string, unknown>([['phases', 'complete']]);
    expect(evalCondition('phases != "complete"', b)).toBe(false);
  });

  it('|| operator: `a || b` short-circuits to true on LHS truthy', () => {
    const b = new Map<string, unknown>([
      ['a', true],
      ['b', false],
    ]);
    expect(evalCondition('a || b', b)).toBe(true);
  });

  it('parens with mixed precedence: `(a || b) && c`', () => {
    const b = new Map<string, unknown>([
      ['a', false],
      ['b', true],
      ['c', true],
    ]);
    expect(evalCondition('(a || b) && c', b)).toBe(true);
    // Same expression, c false → whole thing false.
    b.set('c', false);
    expect(evalCondition('(a || b) && c', b)).toBe(false);
  });

  it('unary `!`: `!hit` inverts truthy/falsy', () => {
    const b = new Map<string, unknown>([['hit', true]]);
    expect(evalCondition('!hit', b)).toBe(false);
    b.set('hit', false);
    expect(evalCondition('!hit', b)).toBe(true);
  });

  it('function call: `len(arr) > 1`', () => {
    const b = new Map<string, unknown>([['arr', ['a', 'b', 'c']]]);
    expect(evalCondition('len(arr) > 1', b)).toBe(true);
  });

  it('function call: `contains(s, "foo")`', () => {
    const b = new Map<string, unknown>([['s', 'hello foobar']]);
    expect(evalCondition('contains(s, "foo")', b)).toBe(true);
  });

  it('treats a MultiEdit tool binding as Edit across alias-aware string functions', () => {
    const b = new Map<string, unknown>([['tool', toPolicyToolValue('MultiEdit')]]);
    expect(evalCondition('tool == "Edit"', b)).toBe(true);
    expect(evalCondition('tool == "MultiEdit"', b)).toBe(true);
    expect(evalCondition('contains(tool, "Edit")', b)).toBe(true);
    expect(evalCondition('startsWith(tool, "Multi")', b)).toBe(true);
    expect(evalCondition('endsWith(tool, "Edit")', b)).toBe(true);
    expect(evalCondition('match(tool, "^(Write|Edit|NotebookEdit)$")', b)).toBe(true);
  });

  it('compound: `committing && phases != "complete"` (the §12.4 production rule)', () => {
    const b = new Map<string, unknown>([
      ['committing', true],
      ['phases', 'partial'],
    ]);
    expect(evalCondition('committing && phases != "complete"', b)).toBe(true);
    // Phase logged → rule no longer fires.
    b.set('phases', 'complete');
    expect(evalCondition('committing && phases != "complete"', b)).toBe(false);
  });
});

describe('evalCondition — error tiers fail-closed with warn', () => {
  beforeEach(() => clear());

  it('parse error → false + warn (e.g. `a &&` — trailing operator)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(evalCondition('a &&', new Map([['a', true]]))).toBe(false);
      const parseWarns = warn.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('parse error'),
      );
      expect(parseWarns.length).toBeGreaterThanOrEqual(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('runtime error → false + warn (unknown function `weirdFn(x)`)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const b = new Map<string, unknown>([['x', 1]]);
      expect(evalCondition('weirdFn(x)', b)).toBe(false);
      const rtWarns = warn.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('runtime error'),
      );
      expect(rtWarns.length).toBeGreaterThanOrEqual(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('interpreter limit → false + warn (depth-cap on 65-deep `||` chain)', () => {
    // Build `(a || (a || (a || ... )))` 65-deep nesting to overflow the
    // 64-depth cap. AST depth is 65 parens + 65 binary nodes, so the
    // interpreter's `depth > MAX_DEPTH` guard fires before any branch.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      let expr = 'a';
      for (let i = 0; i < 70; i++) {
        expr = `(a || ${expr})`;
      }
      const b = new Map<string, unknown>([['a', false]]);
      expect(evalCondition(expr, b)).toBe(false);
      const limitWarns = warn.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('interpreter limit'),
      );
      expect(limitWarns.length).toBeGreaterThanOrEqual(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('evalCondition — parse cache integration', () => {
  beforeEach(() => clear());

  it('same expression twice → cache size increments by 1, not 2', () => {
    const b = new Map<string, unknown>([['x', 1]]);
    expect(stats().size).toBe(0);
    evalCondition('x == 1', b);
    expect(stats().size).toBe(1);
    evalCondition('x == 1', b);
    expect(stats().size).toBe(1); // cache hit, no new entry
  });

  it('two different expressions → cache size = 2', () => {
    const b = new Map<string, unknown>([['x', 1]]);
    evalCondition('x == 1', b);
    evalCondition('x == 2', b);
    expect(stats().size).toBe(2);
  });

  it('empty string does NOT populate cache (short-circuits before parse)', () => {
    evalCondition('', new Map());
    expect(stats().size).toBe(0);
  });

  it('lex/parse errors do NOT populate cache', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      evalCondition('== =', new Map());
      expect(stats().size).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('parseExpression — parse-only entry for H.2 Zod refinement', () => {
  it('round-trips a simple expression to an AST', () => {
    const ast = parseExpression('hit');
    expect(ast.kind).toBe('name');
  });

  it('round-trips a compound expression', () => {
    const ast = parseExpression('x == "FOO" && y.count > 0');
    expect(ast.kind).toBe('binary');
  });

  it('throws on empty string', () => {
    expect(() => parseExpression('')).toThrow(/empty/);
  });

  it('throws on whitespace-only', () => {
    expect(() => parseExpression('   ')).toThrow(/empty/);
  });

  it('throws on lex error (`== =`)', () => {
    expect(() => parseExpression('== =')).toThrow();
  });

  it('throws on parse error (`a &&`)', () => {
    expect(() => parseExpression('a &&')).toThrow();
  });

  it('accepts all 8 production `if:` clauses (per pre-research §1.3)', () => {
    const clauses = [
      'claimed',
      'hit',
      'cmd_hit',
      'committing',
      'candidates == "NONE"',
      'automation.value == true',
      'automation.value == true && classification == "BLOCK"',
      'committing && phases != "complete"',
    ];
    for (const c of clauses) {
      expect(() => parseExpression(c)).not.toThrow();
    }
  });
});
