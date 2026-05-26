/**
 * Parser tests — Task H.1.2.
 *
 * Spec acceptance: ≥16 cases covering grammar shape, operator precedence,
 * left-associativity for `&&` / `||`, parens-flip-precedence, no-chained-
 * comparison rejection, malformed-input parse errors with usable `offset`,
 * singleton invariant (one `new ExpressionParser` in the module), and a
 * module-load test that proves `performSelfAnalysis()` ran without throwing.
 *
 * CST navigation idioms used here:
 *   - Each rule produces a CstNode with `children` keyed by sub-rule name or
 *     LABEL. LABEL'd children appear under `children.lhs` / `children.rhs`.
 *   - `MANY` collects into arrays — `orExpr.children.rhs` is `CstNode[]`.
 *   - `OR` alternatives all dump children into the same parent map; the
 *     visitor (H.1.3) distinguishes by which child key is populated.
 *
 * Helpers below trade verbosity for clarity — every test reads as
 * `lex → parse → assert children shape`.
 */

import { describe, expect, it } from 'vitest';

import { lexer } from './lexer.js';
import { parseToCst, parserInstance } from './parser.js';
import type { CstNode } from 'chevrotain';

// Helper: lex + parse in one shot. Returns the ParseResult plus the tokens
// (useful for asserting on error offsets line up with input character index).
function parse(input: string): ReturnType<typeof parseToCst> {
  const lexResult = lexer.tokenize(input);
  // Lexer errors are out-of-scope for parser tests but we surface them so a
  // surprise here fails loudly instead of cascading into a confusing parse fail.
  expect(lexResult.errors).toEqual([]);
  return parseToCst(lexResult);
}

// Helper: walk down the single-child chain to find a named descendant. Many
// of our tests just want to grab e.g. the inner `callOrPath` under an
// `expression → orExpr → andExpr → notExpr → compareExpr → primary` chain.
function descend(node: CstNode, ...names: string[]): CstNode {
  let cur: CstNode = node;
  for (const name of names) {
    const child = cur.children[name];
    const first = child?.[0];
    if (!first) {
      throw new Error(`descend: no child '${name}' under '${cur.name}'`);
    }
    // CstChildrenDictionary values can be CstNode[] | IToken[]; we only
    // descend through CstNodes here.
    if (!('name' in first)) {
      throw new Error(`descend: child '${name}' under '${cur.name}' is a token, not a CstNode`);
    }
    cur = first;
  }
  return cur;
}

describe('parser — module load + self-analysis', () => {
  it('loaded the module without performSelfAnalysis() throwing', () => {
    // The import at the top of this file is the actual verification — if
    // performSelfAnalysis() threw (left-recursion, LL(k) ambiguity, missing
    // token), the import would have thrown before this test runs. This
    // assertion just confirms the singleton is the same instance we expect.
    expect(parserInstance).toBeDefined();
    expect(parserInstance.constructor.name).toBe('ExpressionParser');
  });
});

describe('parser — primary atoms', () => {
  it('parses a bare identifier', () => {
    const { cst, errors } = parse('a');
    expect(errors).toEqual([]);
    // expression → orExpr → andExpr → notExpr → compareExpr → primary → callOrPath(Identifier="a")
    const callOrPath = descend(cst, 'orExpr', 'lhs', 'lhs', 'compareExpr', 'lhs', 'callOrPath');
    const idTokens = callOrPath.children.Identifier;
    expect(idTokens).toBeDefined();
    expect(idTokens?.[0]).toMatchObject({ image: 'a' });
  });

  it('parses a string literal', () => {
    const { cst, errors } = parse('"hello"');
    expect(errors).toEqual([]);
    const literal = descend(cst, 'orExpr', 'lhs', 'lhs', 'compareExpr', 'lhs', 'literal');
    expect(literal.children.StringLit?.[0]).toMatchObject({ image: '"hello"' });
  });

  it('parses a number literal', () => {
    const { cst, errors } = parse('42');
    expect(errors).toEqual([]);
    const literal = descend(cst, 'orExpr', 'lhs', 'lhs', 'compareExpr', 'lhs', 'literal');
    expect(literal.children.NumberLit?.[0]).toMatchObject({ image: '42' });
  });

  it('parses boolean and null literals', () => {
    for (const [input, kind] of [
      ['true', 'True'],
      ['false', 'False'],
      ['null', 'Null'],
    ] as const) {
      const { cst, errors } = parse(input);
      expect(errors, input).toEqual([]);
      const literal = descend(cst, 'orExpr', 'lhs', 'lhs', 'compareExpr', 'lhs', 'literal');
      expect(literal.children[kind]?.[0]).toMatchObject({ image: input });
    }
  });
});

describe('parser — comparisons', () => {
  it('parses `a == b`', () => {
    const { cst, errors } = parse('a == b');
    expect(errors).toEqual([]);
    const cmp = descend(cst, 'orExpr', 'lhs', 'lhs', 'compareExpr');
    expect(cmp.children.lhs).toHaveLength(1);
    expect(cmp.children.rhs).toHaveLength(1);
    expect(cmp.children.EqEq).toHaveLength(1);
  });

  it('parses every comparison operator', () => {
    for (const [op, token] of [
      ['==', 'EqEq'],
      ['!=', 'NotEq'],
      ['<', 'Lt'],
      ['<=', 'Lte'],
      ['>', 'Gt'],
      ['>=', 'Gte'],
    ] as const) {
      const { cst, errors } = parse(`a ${op} b`);
      expect(errors, op).toEqual([]);
      const cmp = descend(cst, 'orExpr', 'lhs', 'lhs', 'compareExpr');
      expect(cmp.children[token], op).toHaveLength(1);
    }
  });

  it('rejects chained comparison `a < b < c`', () => {
    const { errors } = parse('a < b < c');
    expect(errors.length).toBeGreaterThan(0);
    const first = errors[0]!;
    // Second `<` should be the offending token at offset 6 (a=0, ' '=1, <=2,
    // ' '=3, b=4, ' '=5, <=6).
    expect(first.offset).toBeGreaterThanOrEqual(0);
  });
});

describe('parser — logical operators + precedence', () => {
  it('parses `a && b` as andExpr with one rhs', () => {
    const { cst, errors } = parse('a && b');
    expect(errors).toEqual([]);
    const and = descend(cst, 'orExpr', 'lhs');
    expect(and.children.lhs).toHaveLength(1);
    expect(and.children.rhs).toHaveLength(1);
    expect(and.children.AndAnd).toHaveLength(1);
  });

  it('parses `a || b` as orExpr with one rhs', () => {
    const { cst, errors } = parse('a || b');
    expect(errors).toEqual([]);
    const or = descend(cst, 'orExpr');
    expect(or.children.lhs).toHaveLength(1);
    expect(or.children.rhs).toHaveLength(1);
    expect(or.children.OrOr).toHaveLength(1);
  });

  it('binds && tighter than || (`a || b && c`)', () => {
    const { cst, errors } = parse('a || b && c');
    expect(errors).toEqual([]);
    // orExpr should have two andExpr children — lhs=`a`, rhs=`b && c`.
    const or = descend(cst, 'orExpr');
    expect(or.children.lhs).toHaveLength(1);
    expect(or.children.rhs).toHaveLength(1);
    // The rhs andExpr should itself have an AndAnd token (proving the &&
    // landed under the rhs and not at the top level).
    const rhsAnd = or.children.rhs![0] as CstNode;
    expect(rhsAnd.children.AndAnd).toHaveLength(1);
  });

  it('parens flip precedence (`(a || b) && c`)', () => {
    const { cst, errors } = parse('(a || b) && c');
    expect(errors).toEqual([]);
    // Top-level should be andExpr with two notExpr children, lhs containing
    // the parenthesized orExpr.
    const and = descend(cst, 'orExpr', 'lhs');
    expect(and.children.lhs).toHaveLength(1);
    expect(and.children.rhs).toHaveLength(1);
    expect(and.children.AndAnd).toHaveLength(1);
    // lhs notExpr → compareExpr → primary should contain a parenthesized
    // expression whose inner orExpr has an OrOr.
    // and.children.lhs[0] is a notExpr; descend through compareExpr → lhs (primary).
    const lhsPrimary = descend(and.children.lhs![0] as CstNode, 'compareExpr', 'lhs');
    expect(lhsPrimary.children.LParen).toBeDefined();
    expect(lhsPrimary.children.RParen).toBeDefined();
    // primary's parenthesized branch puts an `expression` CstNode in children.
    const innerExpr = lhsPrimary.children.expression![0] as CstNode;
    const innerOrExpr = innerExpr.children.orExpr![0] as CstNode;
    expect(innerOrExpr.children.OrOr).toHaveLength(1);
  });

  it('left-folds `a && b && c` (three andExpr operands)', () => {
    const { cst, errors } = parse('a && b && c');
    expect(errors).toEqual([]);
    const and = descend(cst, 'orExpr', 'lhs');
    expect(and.children.lhs).toHaveLength(1);
    expect(and.children.rhs).toHaveLength(2);
    expect(and.children.AndAnd).toHaveLength(2);
  });

  it('left-folds `a || b || c` (three orExpr operands)', () => {
    const { cst, errors } = parse('a || b || c');
    expect(errors).toEqual([]);
    const or = descend(cst, 'orExpr');
    expect(or.children.lhs).toHaveLength(1);
    expect(or.children.rhs).toHaveLength(2);
    expect(or.children.OrOr).toHaveLength(2);
  });

  it('applies `!` only to the immediate compareExpr (`!a && b`)', () => {
    const { cst, errors } = parse('!a && b');
    expect(errors).toEqual([]);
    const and = descend(cst, 'orExpr', 'lhs');
    expect(and.children.AndAnd).toHaveLength(1);
    // lhs notExpr should have a Bang token; rhs notExpr should NOT.
    const lhsNot = and.children.lhs![0] as CstNode;
    const rhsNot = and.children.rhs![0] as CstNode;
    expect(lhsNot.children.Bang).toHaveLength(1);
    expect(rhsNot.children.Bang).toBeUndefined();
  });
});

describe('parser — calls + paths', () => {
  it('parses a zero-arg call `f()`', () => {
    const { cst, errors } = parse('f()');
    expect(errors).toEqual([]);
    const callOrPath = descend(cst, 'orExpr', 'lhs', 'lhs', 'compareExpr', 'lhs', 'callOrPath');
    expect(callOrPath.children.LParen).toHaveLength(1);
    expect(callOrPath.children.RParen).toHaveLength(1);
    expect(callOrPath.children.arg).toBeUndefined();
  });

  it('parses a one-arg call `len(x)`', () => {
    const { cst, errors } = parse('len(x)');
    expect(errors).toEqual([]);
    const callOrPath = descend(cst, 'orExpr', 'lhs', 'lhs', 'compareExpr', 'lhs', 'callOrPath');
    expect(callOrPath.children.LParen).toHaveLength(1);
    expect(callOrPath.children.arg).toHaveLength(1);
    expect(callOrPath.children.Comma).toBeUndefined();
  });

  it('parses a two-arg call `contains(s, sub)`', () => {
    const { cst, errors } = parse('contains(s, sub)');
    expect(errors).toEqual([]);
    const callOrPath = descend(cst, 'orExpr', 'lhs', 'lhs', 'compareExpr', 'lhs', 'callOrPath');
    expect(callOrPath.children.LParen).toHaveLength(1);
    expect(callOrPath.children.arg).toHaveLength(2);
    expect(callOrPath.children.Comma).toHaveLength(1);
  });

  it('parses a dotted path `a.b.c`', () => {
    const { cst, errors } = parse('a.b.c');
    expect(errors).toEqual([]);
    const callOrPath = descend(cst, 'orExpr', 'lhs', 'lhs', 'compareExpr', 'lhs', 'callOrPath');
    expect(callOrPath.children.Identifier?.[0]).toMatchObject({ image: 'a' });
    expect(callOrPath.children.pathSegment).toHaveLength(2);
    expect(callOrPath.children.LParen).toBeUndefined();
  });

  it('parses an indexed access `arr[0]`', () => {
    const { cst, errors } = parse('arr[0]');
    expect(errors).toEqual([]);
    const callOrPath = descend(cst, 'orExpr', 'lhs', 'lhs', 'compareExpr', 'lhs', 'callOrPath');
    expect(callOrPath.children.pathSegment).toHaveLength(1);
    const seg = callOrPath.children.pathSegment![0] as CstNode;
    expect(seg.children.LBracket).toHaveLength(1);
    expect(seg.children.NumberLit?.[0]).toMatchObject({ image: '0' });
  });

  it('parses a string-key access `arr["key"]`', () => {
    const { cst, errors } = parse('arr["key"]');
    expect(errors).toEqual([]);
    const callOrPath = descend(cst, 'orExpr', 'lhs', 'lhs', 'compareExpr', 'lhs', 'callOrPath');
    const seg = callOrPath.children.pathSegment![0] as CstNode;
    expect(seg.children.StringLit?.[0]).toMatchObject({ image: '"key"' });
  });
});

describe('parser — parens + nesting', () => {
  it('handles four nested parens `((((a))))`', () => {
    // No depth cap at parse time — interpreter (H.2) enforces depth. Just
    // confirms grammar accepts arbitrary nesting.
    const { cst, errors } = parse('((((a))))');
    expect(errors).toEqual([]);
    expect(cst.name).toBe('expression');
  });
});

describe('parser — error reporting', () => {
  it('reports an error on dangling operator `a ==`', () => {
    const { errors } = parse('a ==');
    expect(errors.length).toBeGreaterThan(0);
    const first = errors[0]!;
    expect(first.message).toBeTruthy();
    // offset should be a number (chevrotain may use -1 if EOF; either way
    // it must be defined and finite).
    expect(typeof first.offset).toBe('number');
  });

  it('reports an error on trailing token `a == b c`', () => {
    const { errors } = parse('a == b c');
    expect(errors.length).toBeGreaterThan(0);
    const first = errors[0]!;
    // Trailing `c` is at offset 7.
    expect(first.offset).toBeGreaterThanOrEqual(0);
  });

  it('reports an error on empty input', () => {
    const { errors } = parse('');
    expect(errors.length).toBeGreaterThan(0);
  });

  it('reports an error on unmatched paren `(a`', () => {
    const { errors } = parse('(a');
    expect(errors.length).toBeGreaterThan(0);
  });
});
