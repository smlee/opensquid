/**
 * AST visitor tests — Task H.1.3.
 *
 * Spec acceptance: ≥10 cases covering all 6 node kinds, left-fold
 * associativity, source-position threading (including 3-leading-space
 * offset test), and StringLit escape processing (`\"` `\\` `\n`).
 *
 * Pipeline per test: `lexer.tokenize(input) → parseToCst → cstToAst`.
 * Lexer/parser errors short-circuit the AST step — the helper asserts
 * empty error arrays so an upstream surprise fails loudly here.
 */

import { describe, expect, it } from 'vitest';

import { assertNever, type ASTNode, type BinaryOp, cstToAst, type PathSegment } from './ast.js';
import { lexer } from './lexer.js';
import { parseToCst } from './parser.js';

// Helper: full lex → parse → AST pipeline. Asserts no upstream errors.
function ast(input: string): ASTNode {
  const lexResult = lexer.tokenize(input);
  expect(lexResult.errors, `lex(${JSON.stringify(input)})`).toEqual([]);
  const parsed = parseToCst(lexResult);
  expect(parsed.errors, `parse(${JSON.stringify(input)})`).toEqual([]);
  return cstToAst(parsed.cst);
}

describe('ast — literals', () => {
  it('lowers a string literal', () => {
    const n = ast('"hello"');
    expect(n).toMatchObject({ kind: 'literal', value: 'hello', offset: 0 });
  });

  it('lowers a number literal (int)', () => {
    expect(ast('42')).toMatchObject({ kind: 'literal', value: 42, offset: 0 });
  });

  it('lowers a number literal (float)', () => {
    expect(ast('3.14')).toMatchObject({ kind: 'literal', value: 3.14, offset: 0 });
  });

  it('lowers true / false / null', () => {
    expect(ast('true')).toMatchObject({ kind: 'literal', value: true });
    expect(ast('false')).toMatchObject({ kind: 'literal', value: false });
    expect(ast('null')).toMatchObject({ kind: 'literal', value: null });
  });

  it('processes string escapes \\" \\\\ \\n', () => {
    // Input source: "say \"hi\"\nok\\done"
    // Lexer image: literal characters " s a y   \ " h i \ "   \ n o k   \ \ d o n e "
    // Expected value: `say "hi"\nok\done` (literal \n becomes newline, \\ becomes \, \" becomes ")
    const n = ast('"say \\"hi\\"\\nok\\\\done"');
    expect(n).toMatchObject({ kind: 'literal', value: 'say "hi"\nok\\done' });
  });
});

describe('ast — name + path + call', () => {
  it('lowers a bare identifier to `name`', () => {
    expect(ast('hit')).toMatchObject({ kind: 'name', id: 'hit', offset: 0 });
  });

  it('lowers `a.b.c` to a path with two prop segments', () => {
    const n = ast('a.b.c');
    expect(n).toMatchObject({
      kind: 'path',
      target: { kind: 'name', id: 'a' },
      segments: [
        { kind: 'prop', name: 'b' },
        { kind: 'prop', name: 'c' },
      ],
      offset: 0,
    });
  });

  it('lowers `arr[0]` to a path with numeric index segment', () => {
    const n = ast('arr[0]');
    expect(n).toMatchObject({
      kind: 'path',
      target: { kind: 'name', id: 'arr' },
      segments: [{ kind: 'index', value: 0 }],
    });
  });

  it('lowers `arr["key"]` to a path with string index segment', () => {
    const n = ast('arr["key"]');
    expect(n).toMatchObject({
      kind: 'path',
      target: { kind: 'name', id: 'arr' },
      segments: [{ kind: 'index', value: 'key' }],
    });
  });

  it('lowers a mixed `a.b[0].c` chain', () => {
    const n = ast('a.b[0].c');
    expect(n.kind).toBe('path');
    if (n.kind !== 'path') return;
    expect(n.segments).toEqual<PathSegment[]>([
      { kind: 'prop', name: 'b' },
      { kind: 'index', value: 0 },
      { kind: 'prop', name: 'c' },
    ]);
  });

  it('lowers a zero-arg call `f()`', () => {
    expect(ast('f()')).toMatchObject({ kind: 'call', name: 'f', args: [], offset: 0 });
  });

  it('lowers a one-arg call `len(x)`', () => {
    const n = ast('len(x)');
    expect(n).toMatchObject({
      kind: 'call',
      name: 'len',
      args: [{ kind: 'name', id: 'x' }],
    });
  });

  it('lowers a two-arg call `contains(s, sub)`', () => {
    const n = ast('contains(s, sub)');
    expect(n).toMatchObject({
      kind: 'call',
      name: 'contains',
      args: [
        { kind: 'name', id: 's' },
        { kind: 'name', id: 'sub' },
      ],
    });
  });
});

describe('ast — unary + binary + precedence', () => {
  it('lowers `!hit` to unary', () => {
    const n = ast('!hit');
    expect(n).toMatchObject({
      kind: 'unary',
      op: '!',
      operand: { kind: 'name', id: 'hit' },
      offset: 0,
    });
  });

  it('lowers `a == b` to binary with EqEq', () => {
    expect(ast('a == b')).toMatchObject({
      kind: 'binary',
      op: '==',
      lhs: { kind: 'name', id: 'a' },
      rhs: { kind: 'name', id: 'b' },
    });
  });

  it('lowers every comparison op', () => {
    const cases: [string, BinaryOp][] = [
      ['a == b', '=='],
      ['a != b', '!='],
      ['a < b', '<'],
      ['a <= b', '<='],
      ['a > b', '>'],
      ['a >= b', '>='],
    ];
    for (const [input, op] of cases) {
      const n = ast(input);
      expect(n, input).toMatchObject({ kind: 'binary', op });
    }
  });

  it('left-folds `a && b && c` (((a&&b)&&c))', () => {
    const n = ast('a && b && c');
    expect(n.kind).toBe('binary');
    if (n.kind !== 'binary') return;
    expect(n.op).toBe('&&');
    // outer rhs = c, outer lhs = (a && b)
    expect(n.rhs).toMatchObject({ kind: 'name', id: 'c' });
    expect(n.lhs).toMatchObject({
      kind: 'binary',
      op: '&&',
      lhs: { kind: 'name', id: 'a' },
      rhs: { kind: 'name', id: 'b' },
    });
  });

  it('left-folds `a || b || c` (((a||b)||c))', () => {
    const n = ast('a || b || c');
    if (n.kind !== 'binary' || n.lhs.kind !== 'binary') {
      throw new Error('expected nested binary || tree');
    }
    expect(n.op).toBe('||');
    expect(n.lhs.op).toBe('||');
    expect(n.rhs).toMatchObject({ kind: 'name', id: 'c' });
  });

  it('binds && tighter than || (`a || b && c` → a || (b && c))', () => {
    const n = ast('a || b && c');
    if (n.kind !== 'binary') throw new Error('expected binary root');
    expect(n.op).toBe('||');
    expect(n.lhs).toMatchObject({ kind: 'name', id: 'a' });
    expect(n.rhs).toMatchObject({
      kind: 'binary',
      op: '&&',
      lhs: { kind: 'name', id: 'b' },
      rhs: { kind: 'name', id: 'c' },
    });
  });

  it('parens flip precedence (`(a || b) && c`)', () => {
    const n = ast('(a || b) && c');
    if (n.kind !== 'binary') throw new Error('expected binary root');
    expect(n.op).toBe('&&');
    expect(n.lhs).toMatchObject({
      kind: 'binary',
      op: '||',
      lhs: { kind: 'name', id: 'a' },
      rhs: { kind: 'name', id: 'b' },
    });
    expect(n.rhs).toMatchObject({ kind: 'name', id: 'c' });
  });

  it('applies `!` only to the immediate compare (`!a && b`)', () => {
    const n = ast('!a && b');
    if (n.kind !== 'binary') throw new Error('expected binary root');
    expect(n.op).toBe('&&');
    expect(n.lhs).toMatchObject({ kind: 'unary', op: '!', operand: { kind: 'name', id: 'a' } });
    expect(n.rhs).toMatchObject({ kind: 'name', id: 'b' });
  });
});

describe('ast — source positions', () => {
  it('threads token offset for a bare name', () => {
    expect(ast('hit').offset).toBe(0);
  });

  it('uses LHS offset for synthesized binary nodes (3 leading spaces)', () => {
    const n = ast('   a == b');
    expect(n.kind).toBe('binary');
    expect(n.offset).toBe(3);
  });

  it('uses Bang offset for unary nodes', () => {
    // `  !hit` → bang is at offset 2.
    const n = ast('  !hit');
    expect(n).toMatchObject({ kind: 'unary', op: '!', offset: 2 });
  });

  it('uses Identifier offset for call nodes', () => {
    const n = ast('  len(x)');
    expect(n).toMatchObject({ kind: 'call', name: 'len', offset: 2 });
  });

  it('inherits leftmost offset across left-folded chain', () => {
    // `a && b && c` — outer binary, outer.lhs (also binary), all share offset 0.
    const n = ast('a && b && c');
    expect(n.offset).toBe(0);
    if (n.kind === 'binary' && n.lhs.kind === 'binary') {
      expect(n.lhs.offset).toBe(0);
    }
  });
});

describe('ast — exhaustiveness helper', () => {
  it('assertNever throws on any value', () => {
    // Cast through unknown to bypass the never constraint at the callsite —
    // simulates the runtime path when a future kind sneaks past typecheck.
    expect(() => assertNever('surprise' as unknown as never)).toThrow(/Unhandled AST kind/);
  });

  it('compiles an exhaustive switch over ASTNode["kind"]', () => {
    // This function exists purely to prove the discriminated union is
    // exhaustive — commenting any case out fails `pnpm typecheck` because
    // `assertNever(node)` then receives a non-never argument.
    function describe(node: ASTNode): string {
      switch (node.kind) {
        case 'literal':
          return 'lit';
        case 'name':
          return 'name';
        case 'path':
          return 'path';
        case 'call':
          return 'call';
        case 'unary':
          return 'unary';
        case 'binary':
          return 'binary';
        default:
          return assertNever(node);
      }
    }
    expect(describe(ast('1'))).toBe('lit');
    expect(describe(ast('x'))).toBe('name');
    expect(describe(ast('x.y'))).toBe('path');
    expect(describe(ast('f()'))).toBe('call');
    expect(describe(ast('!x'))).toBe('unary');
    expect(describe(ast('a && b'))).toBe('binary');
  });
});
