/**
 * Function allow-list tests — Task H.1.5.
 *
 * Acceptance contract (spec H.1.5):
 *   - ≥15 cases total (3 per function × 5 functions).
 *   - Each function: happy path + type-mismatch + edge (empty/null).
 *   - FUNCTIONS is frozen — direct mutation throws in strict mode.
 *   - `match()` does NOT throw on a bad-regex input (returns false).
 *   - DO NOT include an actual ReDoS payload in CI — the v1 plain-RegExp
 *     path would hang the test suite. Only test that `match` exists and
 *     handles bad-regex via the try/catch. H.4 is the redos-hardening
 *     follow-up that makes ReDoS testing safe.
 */

import { describe, expect, it } from 'vitest';

import { FUNCTIONS, type FnHandler } from './functions.js';

// Cast the registry to a positionally-typed function-record so individual
// handler calls type-check cleanly. The runtime registry is still frozen +
// null-prototype; this cast only affects the test surface.
const fn = FUNCTIONS as unknown as Record<string, FnHandler>;

describe('FUNCTIONS registry — frozen allow-list discipline', () => {
  it('exposes exactly the 5 documented functions (no more, no fewer)', () => {
    // `Object.keys` on a frozen null-prototype object returns the own
    // string keys we assigned at construction. New additions trip this.
    expect(Object.keys(FUNCTIONS).sort()).toEqual(
      ['contains', 'endsWith', 'len', 'match', 'startsWith'].sort(),
    );
  });

  it('is frozen — direct mutation throws in strict mode', () => {
    // ES modules execute in strict mode automatically; assignment to a
    // frozen property throws TypeError rather than silently failing.
    expect(() => {
      fn.evil = () => true;
    }).toThrow(TypeError);
  });

  it('has a null prototype — reserved JS slot names resolve to undefined', () => {
    // Bracket access on `__proto__` / `constructor` / `toString` must not
    // inherit anything from Object.prototype. The interpreter's call
    // branch relies on `typeof fn !== 'function'` rejecting these.
    // Dot notation is silently equivalent here, but bracket-access spells
    // out that we're auditing exactly the same dispatch shape the
    // interpreter uses (`registry[node.name]`).
    /* eslint-disable @typescript-eslint/dot-notation -- mirror interpreter's bracket-access dispatch. */
    expect(fn['__proto__']).toBeUndefined();
    expect(fn['constructor']).toBeUndefined();
    expect(fn['toString']).toBeUndefined();
    expect(fn['hasOwnProperty']).toBeUndefined();
    /* eslint-enable @typescript-eslint/dot-notation */
  });
});

// ---- len(x) -------------------------------------------------------------

describe('len(x)', () => {
  it('returns char count for strings', () => {
    expect(fn.len!('hello')).toBe(5);
    expect(fn.len!('')).toBe(0);
  });
  it('returns array length', () => {
    expect(fn.len!([1, 2, 3])).toBe(3);
    expect(fn.len!([])).toBe(0);
  });
  it('returns Object.keys().length for objects', () => {
    expect(fn.len!({ a: 1, b: 2 })).toBe(2);
    expect(fn.len!({})).toBe(0);
  });
  it('returns 0 for null / undefined / numbers / booleans (type mismatch)', () => {
    expect(fn.len!(null)).toBe(0);
    expect(fn.len!(undefined)).toBe(0);
    expect(fn.len!(42)).toBe(0);
    expect(fn.len!(true)).toBe(0);
  });
});

// ---- contains(s, sub) ---------------------------------------------------

describe('contains(s, sub)', () => {
  it('returns true when sub is a substring of s', () => {
    expect(fn.contains!('hello world', 'world')).toBe(true);
    expect(fn.contains!('foo', 'foo')).toBe(true);
    expect(fn.contains!('foo', '')).toBe(true); // empty substring always present
  });
  it('returns false when sub is absent', () => {
    expect(fn.contains!('hello', 'x')).toBe(false);
    expect(fn.contains!('', 'x')).toBe(false);
  });
  it('returns false on type mismatch (no coercion)', () => {
    expect(fn.contains!(123, '1')).toBe(false);
    expect(fn.contains!('123', 1)).toBe(false);
    expect(fn.contains!(null, 'x')).toBe(false);
    expect(fn.contains!('x', undefined)).toBe(false);
    expect(fn.contains!(['x'], 'x')).toBe(false); // arrays don't count as strings
  });
});

// ---- startsWith(s, p) ---------------------------------------------------

describe('startsWith(s, p)', () => {
  it('returns true when s starts with p', () => {
    expect(fn.startsWith!('hello', 'he')).toBe(true);
    expect(fn.startsWith!('hello', 'hello')).toBe(true);
    expect(fn.startsWith!('hello', '')).toBe(true); // empty prefix always matches
  });
  it('returns false when s does not start with p', () => {
    expect(fn.startsWith!('hello', 'world')).toBe(false);
    expect(fn.startsWith!('hello', 'ello')).toBe(false); // prefix only, not substring
  });
  it('returns false on type mismatch', () => {
    expect(fn.startsWith!(null, 'x')).toBe(false);
    expect(fn.startsWith!('x', null)).toBe(false);
    expect(fn.startsWith!([], 'x')).toBe(false);
  });
});

// ---- endsWith(s, p) -----------------------------------------------------

describe('endsWith(s, p)', () => {
  it('returns true when s ends with p', () => {
    expect(fn.endsWith!('hello', 'lo')).toBe(true);
    expect(fn.endsWith!('hello', 'hello')).toBe(true);
    expect(fn.endsWith!('hello', '')).toBe(true);
  });
  it('returns false when s does not end with p', () => {
    expect(fn.endsWith!('hello', 'x')).toBe(false);
    expect(fn.endsWith!('hello', 'hell')).toBe(false); // suffix only
  });
  it('returns false on type mismatch', () => {
    expect(fn.endsWith!([], 'x')).toBe(false);
    expect(fn.endsWith!('x', 42)).toBe(false);
    expect(fn.endsWith!(undefined, 'x')).toBe(false);
  });
});

// ---- match(s, pattern) --------------------------------------------------

describe('match(s, pattern)', () => {
  it('returns true when pattern matches s', () => {
    expect(fn.match!('foo123', '^foo\\d+$')).toBe(true);
    expect(fn.match!('xyz', '^x')).toBe(true);
  });
  it('returns false when pattern does not match', () => {
    expect(fn.match!('bar', '^foo')).toBe(false);
    expect(fn.match!('', 'x')).toBe(false);
  });
  it('returns false on invalid regex (try/catch swallows compile error)', () => {
    // Unbalanced paren — `new RegExp("(")` throws SyntaxError; the function
    // catches it and returns false. NO TODO comment per H.1.5 spec — the
    // H.4 task slot tracks the redos-hardening upgrade.
    expect(fn.match!('x', '(')).toBe(false);
    expect(fn.match!('x', '[')).toBe(false);
    expect(fn.match!('x', '\\')).toBe(false);
  });
  it('returns false on type mismatch (no coercion)', () => {
    expect(fn.match!(null, 'x')).toBe(false);
    expect(fn.match!('x', null)).toBe(false);
    expect(fn.match!(42, '\\d+')).toBe(false);
    expect(fn.match!('x', /x/)).toBe(false); // RegExp objects rejected — must be string
  });
  it('exists on the registry (do NOT exercise adversarial ReDoS patterns — H.4)', () => {
    // Acknowledging §12.1 lock: plain RegExp is ReDoS-vulnerable. A real
    // adversarial pattern (`(a+)+$` vs `aaaa...b`) would hang this test.
    // Just confirm the function is wired up.
    expect(typeof fn.match).toBe('function');
  });
});
