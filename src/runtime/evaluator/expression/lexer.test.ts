/**
 * Lexer tests — Task H.1.1.
 *
 * Per spec acceptance criteria: ≥12 cases covering all token kinds, every
 * longest-match edge case (`==`/`===`, `!=`/`!==`, `<`/`<=`, `>`/`>=`,
 * `!`/`!=`, `&&`/`&`, `||`/`|`), keyword word-boundary (`truer` →
 * Identifier, not [True, Identifier("r")]), whitespace skip, and the
 * unknown-character lexer error path.
 *
 * Each test uses the singleton `lexer` from lexer.ts and asserts on the
 * resulting tokens' `tokenType.name` plus their `image` text. WhiteSpace
 * is SKIPPED so it never appears in `tokens`; lexer errors surface in the
 * `errors` array rather than throwing.
 */

import { describe, expect, it } from 'vitest';

import { lexer } from './lexer.js';

// Helper: tokenize and return [name, image] pairs for terse assertions.
function tokenize(input: string): { kinds: [string, string][]; errors: string[] } {
  const result = lexer.tokenize(input);
  return {
    kinds: result.tokens.map((t) => [t.tokenType.name, t.image] as [string, string]),
    errors: result.errors.map((e) => e.message),
  };
}

describe('lexer — single tokens', () => {
  it('tokenizes a bare identifier', () => {
    const { kinds, errors } = tokenize('hit');
    expect(errors).toEqual([]);
    expect(kinds).toEqual([['Identifier', 'hit']]);
  });

  it('tokenizes an integer NumberLit', () => {
    const { kinds, errors } = tokenize('42');
    expect(errors).toEqual([]);
    expect(kinds).toEqual([['NumberLit', '42']]);
  });

  it('tokenizes a float NumberLit', () => {
    const { kinds, errors } = tokenize('3.14');
    expect(errors).toEqual([]);
    expect(kinds).toEqual([['NumberLit', '3.14']]);
  });

  it('tokenizes a StringLit including escaped quotes', () => {
    // Source: "hello\"world" — the raw lexeme includes the surrounding "s.
    const { kinds, errors } = tokenize('"hello\\"world"');
    expect(errors).toEqual([]);
    expect(kinds).toEqual([['StringLit', '"hello\\"world"']]);
  });

  it('tokenizes the three keyword literals', () => {
    expect(tokenize('true').kinds).toEqual([['True', 'true']]);
    expect(tokenize('false').kinds).toEqual([['False', 'false']]);
    expect(tokenize('null').kinds).toEqual([['Null', 'null']]);
  });
});

describe('lexer — longest-match edge cases', () => {
  it('prefers === over == over =', () => {
    // == form
    expect(tokenize('a == b').kinds).toEqual([
      ['Identifier', 'a'],
      ['EqEq', '=='],
      ['Identifier', 'b'],
    ]);
    // === form (longest-match: === beats ==)
    expect(tokenize('a === b').kinds).toEqual([
      ['Identifier', 'a'],
      ['EqEq', '==='],
      ['Identifier', 'b'],
    ]);
  });

  it('prefers !== over != over !', () => {
    // != form
    expect(tokenize('a != b').kinds).toEqual([
      ['Identifier', 'a'],
      ['NotEq', '!='],
      ['Identifier', 'b'],
    ]);
    // !== form (longest-match: !== beats !=)
    expect(tokenize('a !== b').kinds).toEqual([
      ['Identifier', 'a'],
      ['NotEq', '!=='],
      ['Identifier', 'b'],
    ]);
    // Bang form — `!hit` must NOT greedy-match into NotEq because no `=`
    // follows the `!`.
    expect(tokenize('!hit').kinds).toEqual([
      ['Bang', '!'],
      ['Identifier', 'hit'],
    ]);
  });

  it('prefers <= over < and >= over >', () => {
    expect(tokenize('x <= 5').kinds).toEqual([
      ['Identifier', 'x'],
      ['Lte', '<='],
      ['NumberLit', '5'],
    ]);
    expect(tokenize('x < 5').kinds).toEqual([
      ['Identifier', 'x'],
      ['Lt', '<'],
      ['NumberLit', '5'],
    ]);
    expect(tokenize('x >= 5').kinds).toEqual([
      ['Identifier', 'x'],
      ['Gte', '>='],
      ['NumberLit', '5'],
    ]);
    expect(tokenize('x > 5').kinds).toEqual([
      ['Identifier', 'x'],
      ['Gt', '>'],
      ['NumberLit', '5'],
    ]);
  });

  it('lexes && as AndAnd; bare & is an error (not tokenized as a single &)', () => {
    expect(tokenize('true && false').kinds).toEqual([
      ['True', 'true'],
      ['AndAnd', '&&'],
      ['False', 'false'],
    ]);
    // Single `&` has no defined token — must error, not silently emit anything.
    const lone = tokenize('a & b');
    expect(lone.errors.length).toBeGreaterThan(0);
  });

  it('lexes || as OrOr; bare | is an error (not tokenized as a single |)', () => {
    expect(tokenize('true || false').kinds).toEqual([
      ['True', 'true'],
      ['OrOr', '||'],
      ['False', 'false'],
    ]);
    const lone = tokenize('a | b');
    expect(lone.errors.length).toBeGreaterThan(0);
  });
});

describe('lexer — keyword word-boundary', () => {
  it('treats `truer` as Identifier, not [True, Identifier("r")]', () => {
    expect(tokenize('truer').kinds).toEqual([['Identifier', 'truer']]);
  });

  it('treats `falsehood` and `nullable` as Identifiers', () => {
    expect(tokenize('falsehood').kinds).toEqual([['Identifier', 'falsehood']]);
    expect(tokenize('nullable').kinds).toEqual([['Identifier', 'nullable']]);
  });
});

describe('lexer — whitespace + punctuation + path access', () => {
  it('skips whitespace (no WhiteSpace token in output)', () => {
    const { kinds, errors } = tokenize('   x   ');
    expect(errors).toEqual([]);
    expect(kinds).toEqual([['Identifier', 'x']]);
  });

  it('tokenizes dotted path with numeric index', () => {
    expect(tokenize('x.y[0]').kinds).toEqual([
      ['Identifier', 'x'],
      ['Dot', '.'],
      ['Identifier', 'y'],
      ['LBracket', '['],
      ['NumberLit', '0'],
      ['RBracket', ']'],
    ]);
  });

  it('tokenizes a call shape with comma-separated args', () => {
    expect(tokenize('len(a, b)').kinds).toEqual([
      ['Identifier', 'len'],
      ['LParen', '('],
      ['Identifier', 'a'],
      ['Comma', ','],
      ['Identifier', 'b'],
      ['RParen', ')'],
    ]);
  });
});

describe('lexer — error handling', () => {
  it('produces a lex error for an unknown character (`@`)', () => {
    const { errors } = tokenize('@invalid');
    expect(errors.length).toBeGreaterThan(0);
    // The error message should reference the offending character or its position.
    expect(errors[0]).toMatch(/@|unexpected|unable/i);
  });
});
