/**
 * Tree-walking interpreter tests — Task H.1.4.
 *
 * Acceptance contract (per spec H.1.4):
 *   - ≥20 tests; all 6 AST node kinds exercised.
 *   - Short-circuit verified for `&&` and `||` (RHS not invoked when LHS
 *     short-circuits — verified via a throwing function on the RHS).
 *   - Depth cap fires at 65 (off-by-one: 64 deep OK, 65 throws).
 *   - Step cap fires at MAX_STEPS+1 (off-by-one).
 *   - `__proto__` / `constructor` / `prototype` accesses return undefined.
 *   - Strict equality (no coercion). Type-mismatch comparators return false.
 *   - `length` special-case on arrays AND strings.
 *   - Call dispatch via FUNCTIONS stub (registry populated locally for the
 *     call-dispatch test only — H.1.5 lands the real registry).
 *
 * Tests bypass parser by constructing AST nodes directly — this keeps the
 * interpreter fixtures resilient to grammar changes upstream and isolates
 * sandbox behavior from parse-error noise.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { ASTNode, BinaryOp, PathSegment } from './ast.js';
import { FUNCTIONS } from './functions.js';
import {
  type EvalCtx,
  evaluate,
  InterpreterLimitError,
  InterpreterRuntimeError,
  MAX_DEPTH,
  MAX_STEPS,
} from './interpreter.js';

// ---- AST construction helpers --------------------------------------------

const lit = (value: string | number | boolean | null): ASTNode => ({
  kind: 'literal',
  value,
  offset: 0,
});
const name = (id: string): ASTNode => ({ kind: 'name', id, offset: 0 });
const path = (target: ASTNode, segments: PathSegment[]): ASTNode => ({
  kind: 'path',
  target,
  segments,
  offset: 0,
});
const prop = (n: string): PathSegment => ({ kind: 'prop', name: n });
const idx = (v: number | string): PathSegment => ({ kind: 'index', value: v });
const call = (fnName: string, args: ASTNode[]): ASTNode => ({
  kind: 'call',
  name: fnName,
  args,
  offset: 0,
});
const not = (operand: ASTNode): ASTNode => ({ kind: 'unary', op: '!', operand, offset: 0 });
const bin = (op: BinaryOp, lhs: ASTNode, rhs: ASTNode): ASTNode => ({
  kind: 'binary',
  op,
  lhs,
  rhs,
  offset: 0,
});

// Fresh context per call so the step counter starts at zero.
const ctx = (bindings: Record<string, unknown> = {}): EvalCtx => ({
  bindings: new Map(Object.entries(bindings)),
  steps: 0,
});

// ---- Literals ------------------------------------------------------------

describe('interpreter — literals', () => {
  it('evaluates a number literal', () => {
    expect(evaluate(lit(42), ctx())).toBe(42);
  });
  it('evaluates a string literal', () => {
    expect(evaluate(lit('hello'), ctx())).toBe('hello');
  });
  it('evaluates true / false / null', () => {
    expect(evaluate(lit(true), ctx())).toBe(true);
    expect(evaluate(lit(false), ctx())).toBe(false);
    expect(evaluate(lit(null), ctx())).toBe(null);
  });
});

// ---- Names ---------------------------------------------------------------

describe('interpreter — names', () => {
  it('resolves a bound name', () => {
    expect(evaluate(name('hit'), ctx({ hit: true }))).toBe(true);
  });
  it('returns undefined for an unbound name', () => {
    expect(evaluate(name('missing'), ctx())).toBeUndefined();
  });
});

// ---- Binary: strict equality (§12.3 lock) --------------------------------

describe('interpreter — binary equality (strict, no coercion)', () => {
  it('1 === 1 → true', () => {
    expect(evaluate(bin('==', lit(1), lit(1)), ctx())).toBe(true);
  });
  it('1 === "1" → false (strict, no String() wrap)', () => {
    expect(evaluate(bin('==', lit(1), lit('1')), ctx())).toBe(false);
  });
  it('"foo" === "foo" → true', () => {
    expect(evaluate(bin('==', lit('foo'), lit('foo')), ctx())).toBe(true);
  });
  it('!=: 1 !== 2 → true', () => {
    expect(evaluate(bin('!=', lit(1), lit(2)), ctx())).toBe(true);
  });
  it('!=: 1 !== "1" → true (strict; types differ)', () => {
    expect(evaluate(bin('!=', lit(1), lit('1')), ctx())).toBe(true);
  });
});

// ---- Binary: relational (type-mismatch → false) --------------------------

describe('interpreter — binary relational (number-typed only)', () => {
  it('5 < 10 → true', () => {
    expect(evaluate(bin('<', lit(5), lit(10)), ctx())).toBe(true);
  });
  it('"a" < "b" → false (strings rejected by typeof guard)', () => {
    expect(evaluate(bin('<', lit('a'), lit('b')), ctx())).toBe(false);
  });
  it('10 <= 10 → true', () => {
    expect(evaluate(bin('<=', lit(10), lit(10)), ctx())).toBe(true);
  });
  it('10 > 5 → true', () => {
    expect(evaluate(bin('>', lit(10), lit(5)), ctx())).toBe(true);
  });
  it('5 >= 10 → false', () => {
    expect(evaluate(bin('>=', lit(5), lit(10)), ctx())).toBe(false);
  });
});

// ---- Binary: short-circuit && / || ---------------------------------------

describe('interpreter — short-circuit', () => {
  // Inject a throw-on-call function for the duration of these tests. The
  // RHS-throws fixture is the definitive proof of short-circuit: if RHS
  // were evaluated, the function would throw, and the test would fail.
  afterEach(() => {
    delete FUNCTIONS.boom;
  });

  it('&& short-circuits when LHS is falsy (RHS never evaluated)', () => {
    FUNCTIONS.boom = () => {
      throw new Error('RHS evaluated despite LHS falsy');
    };
    expect(evaluate(bin('&&', lit(false), call('boom', [])), ctx())).toBe(false);
  });

  it('&& evaluates RHS when LHS is truthy', () => {
    expect(evaluate(bin('&&', lit(true), lit(7)), ctx())).toBe(7);
  });

  it('|| short-circuits when LHS is truthy (RHS never evaluated)', () => {
    FUNCTIONS.boom = () => {
      throw new Error('RHS evaluated despite LHS truthy');
    };
    expect(evaluate(bin('||', lit('lhs'), call('boom', [])), ctx())).toBe('lhs');
  });

  it('|| evaluates RHS when LHS is falsy', () => {
    expect(evaluate(bin('||', lit(0), lit('rhs')), ctx())).toBe('rhs');
  });
});

// ---- Unary --------------------------------------------------------------

describe('interpreter — unary !', () => {
  it('!true → false', () => {
    expect(evaluate(not(lit(true)), ctx())).toBe(false);
  });
  it('!0 → true (JS-truthy applied to operand)', () => {
    expect(evaluate(not(lit(0)), ctx())).toBe(true);
  });
  it('!"" → true', () => {
    expect(evaluate(not(lit('')), ctx())).toBe(true);
  });
});

// ---- Path resolution ----------------------------------------------------

describe('interpreter — path resolution', () => {
  it('walks a 3-segment dotted path', () => {
    const n = path(name('a'), [prop('b'), prop('c')]);
    expect(evaluate(n, ctx({ a: { b: { c: 42 } } }))).toBe(42);
  });
  it('returns undefined for a missing leaf', () => {
    const n = path(name('a'), [prop('b'), prop('c')]);
    expect(evaluate(n, ctx({ a: { b: {} } }))).toBeUndefined();
  });
  it('returns undefined when an intermediate is undefined', () => {
    const n = path(name('a'), [prop('b')]);
    expect(evaluate(n, ctx({ a: undefined }))).toBeUndefined();
  });
  it('returns undefined when an intermediate is null', () => {
    const n = path(name('a'), [prop('b')]);
    expect(evaluate(n, ctx({ a: null }))).toBeUndefined();
  });
  it('reads array.length (non-own getter special-case, G.5 contract)', () => {
    const n = path(name('arr'), [prop('length')]);
    expect(evaluate(n, ctx({ arr: [1, 2, 3] }))).toBe(3);
  });
  it('reads string.length (non-own getter special-case)', () => {
    const n = path(name('s'), [prop('length')]);
    expect(evaluate(n, ctx({ s: 'hello' }))).toBe(5);
  });
  it('reads array by numeric index', () => {
    const n = path(name('arr'), [idx(0)]);
    expect(evaluate(n, ctx({ arr: ['x', 'y'] }))).toBe('x');
  });
  it('returns undefined for out-of-bounds index', () => {
    const n = path(name('arr'), [idx(5)]);
    expect(evaluate(n, ctx({ arr: [] }))).toBeUndefined();
  });
  it('reads object by string index', () => {
    const n = path(name('o'), [idx('key')]);
    expect(evaluate(n, ctx({ o: { key: 'v' } }))).toBe('v');
  });
  it('returns undefined for numeric index on non-array', () => {
    const n = path(name('o'), [idx(0)]);
    expect(evaluate(n, ctx({ o: { key: 'v' } }))).toBeUndefined();
  });
});

// ---- Prototype-pollution defenses ---------------------------------------

describe('interpreter — prototype-pollution defenses (Object.hasOwn)', () => {
  it('__proto__ as bare name → bindings.get returns undefined', () => {
    // Map.get('__proto__') is undefined unless caller .set() it — no
    // prototype-chain lookup happens on a Map.
    expect(evaluate(name('__proto__'), ctx())).toBeUndefined();
  });
  it('x.__proto__ on a plain object → undefined (not own property)', () => {
    const n = path(name('x'), [prop('__proto__')]);
    expect(evaluate(n, ctx({ x: {} }))).toBeUndefined();
  });
  it('x.constructor on a plain object → undefined', () => {
    const n = path(name('x'), [prop('constructor')]);
    expect(evaluate(n, ctx({ x: {} }))).toBeUndefined();
  });
  it('x.prototype on a plain object → undefined', () => {
    const n = path(name('x'), [prop('prototype')]);
    expect(evaluate(n, ctx({ x: {} }))).toBeUndefined();
  });
  it('x.toString on a plain object → undefined (not own)', () => {
    const n = path(name('x'), [prop('toString')]);
    expect(evaluate(n, ctx({ x: {} }))).toBeUndefined();
  });
  it('x["__proto__"] via string index → undefined', () => {
    const n = path(name('x'), [idx('__proto__')]);
    expect(evaluate(n, ctx({ x: {} }))).toBeUndefined();
  });
});

// ---- Depth + step caps --------------------------------------------------

describe('interpreter — depth cap (off-by-one)', () => {
  // Build a left-folded chain of `lit(true) && lit(true) && ...` with N
  // operands. AST nesting depth equals N-1 (each && adds one binary layer
  // above the leftmost literal). The leftmost literal lives at depth N-1.
  function chain(operands: number): ASTNode {
    let acc: ASTNode = lit(true);
    for (let i = 1; i < operands; i++) acc = bin('&&', acc, lit(true));
    return acc;
  }

  it(`depth ${MAX_DEPTH} is allowed (boundary OK)`, () => {
    // operands = MAX_DEPTH+1 puts the leftmost literal at depth MAX_DEPTH.
    expect(evaluate(chain(MAX_DEPTH + 1), ctx())).toBe(true);
  });

  it(`depth ${MAX_DEPTH + 1} throws InterpreterLimitError`, () => {
    expect(() => evaluate(chain(MAX_DEPTH + 2), ctx())).toThrow(InterpreterLimitError);
    expect(() => evaluate(chain(MAX_DEPTH + 2), ctx())).toThrow(/depth>64/);
  });
});

describe('interpreter — step cap (off-by-one)', () => {
  it(`exactly ${MAX_STEPS} visits is allowed`, () => {
    // Each call to evaluate() bumps steps once. Building a tree that visits
    // exactly MAX_STEPS nodes requires bounded depth — so use a wide |||
    // chain stopped just at the cap. We do it via direct counter inspection
    // instead: a single literal visit increments steps to 1.
    const c = ctx();
    c.steps = MAX_STEPS - 1; // one more visit takes us to MAX_STEPS exactly
    expect(evaluate(lit(true), c)).toBe(true);
    expect(c.steps).toBe(MAX_STEPS);
  });

  it(`step ${MAX_STEPS + 1} throws InterpreterLimitError`, () => {
    const c = ctx();
    c.steps = MAX_STEPS; // next visit would make it MAX_STEPS+1
    expect(() => evaluate(lit(true), c)).toThrow(InterpreterLimitError);
    expect(() => {
      const c2 = ctx();
      c2.steps = MAX_STEPS;
      evaluate(lit(true), c2);
    }).toThrow(/steps>10000/);
  });
});

// ---- Call dispatch (FUNCTIONS stub) -------------------------------------

describe('interpreter — call dispatch', () => {
  afterEach(() => {
    delete FUNCTIONS.len;
  });

  it('len([1,2]) → 2 (via locally injected stub; real registry lands in H.1.5)', () => {
    FUNCTIONS.len = (x: unknown) => (Array.isArray(x) ? x.length : 0);
    // Construct a literal array — paths/names would need a binding. The
    // call-dispatch test is about the registry lookup + arg passing,
    // not about how the array got into the AST.
    const arrBinding = call('len', [name('arr')]);
    expect(evaluate(arrBinding, ctx({ arr: [1, 2] }))).toBe(2);
  });

  it('unknown function name throws InterpreterRuntimeError', () => {
    expect(() => evaluate(call('unknownFn', []), ctx())).toThrow(InterpreterRuntimeError);
    expect(() => evaluate(call('unknownFn', []), ctx())).toThrow(/unknown function: unknownFn/);
  });

  it('passes undefined / null args through to the dispatched function', () => {
    // Documents arg-passthrough convention for H.1.5: missing-name bindings
    // resolve to undefined and are forwarded unchanged. Functions handle
    // their own null/undefined semantics.
    let captured: unknown[] = [];
    FUNCTIONS.len = (...args: unknown[]) => {
      captured = args;
      return 0;
    };
    evaluate(call('len', [name('missing'), lit(null)]), ctx());
    expect(captured).toEqual([undefined, null]);
  });
});
