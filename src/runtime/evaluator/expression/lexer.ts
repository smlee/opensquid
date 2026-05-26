/**
 * Expression lexer — Task H.1.1 (chevrotain v11).
 *
 * Tokens for the `if:` expression grammar that replaces the regex-bounded
 * evaluator at src/runtime/evaluator.ts:503. Twenty tokens total: literals
 * (StringLit / NumberLit / True / False / Null), comparison + logical
 * operators, grouping punctuation, and Identifier. WhiteSpace is captured
 * but discarded via the Lexer.SKIPPED group so the parser never sees it.
 *
 * Longest-match discipline: chevrotain walks `allTokens` in array order, so
 * multi-character operators MUST precede their single-character prefixes
 * (EqEq before any `=`-prefixed single token; NotEq before Bang; Lte/Gte
 * before Lt/Gt; AndAnd/OrOr before any single `&` / `|` which are NOT
 * tokenized — they would surface as a lexer error). Keywords use `\b`
 * word-boundaries so `truer` lexes as a single Identifier rather than
 * [True, Identifier("r")].
 *
 * No regex backtracking risk: every pattern is linear-time. StringLit's
 * `/"(?:[^"\\]|\\.)*"/` has no nested quantifiers (each alternative consumes
 * exactly one character of input). Audit-grep in the task spec verifies no
 * lookarounds / possessive / nested quantifiers ever land here.
 *
 * Pinned to chevrotain ^11.0.0 — v12 requires Node 22+ but opensquid pins
 * `engines.node: ">=20.0.0"`.
 *
 * Imported by: src/runtime/evaluator/expression/parser.ts (H.1.2).
 */

import { createToken, Lexer } from 'chevrotain';

// Literals -----------------------------------------------------------------

export const StringLit = createToken({ name: 'StringLit', pattern: /"(?:[^"\\]|\\.)*"/ });
export const NumberLit = createToken({ name: 'NumberLit', pattern: /\d+(?:\.\d+)?/ });

// Keywords — `\b` ensures `truer` / `falsey` / `nullable` are Identifiers.
export const True = createToken({ name: 'True', pattern: /true\b/ });
export const False = createToken({ name: 'False', pattern: /false\b/ });
export const Null = createToken({ name: 'Null', pattern: /null\b/ });

// Operators — multi-char FIRST so longest-match wins.
export const EqEq = createToken({ name: 'EqEq', pattern: /===|==/ });
export const NotEq = createToken({ name: 'NotEq', pattern: /!==|!=/ });
export const Lte = createToken({ name: 'Lte', pattern: /<=/ });
export const Gte = createToken({ name: 'Gte', pattern: />=/ });
export const Lt = createToken({ name: 'Lt', pattern: /</ });
export const Gt = createToken({ name: 'Gt', pattern: />/ });
export const AndAnd = createToken({ name: 'AndAnd', pattern: /&&/ });
export const OrOr = createToken({ name: 'OrOr', pattern: /\|\|/ });
export const Bang = createToken({ name: 'Bang', pattern: /!/ });

// Punctuation -------------------------------------------------------------

export const LParen = createToken({ name: 'LParen', pattern: /\(/ });
export const RParen = createToken({ name: 'RParen', pattern: /\)/ });
export const LBracket = createToken({ name: 'LBracket', pattern: /\[/ });
export const RBracket = createToken({ name: 'RBracket', pattern: /\]/ });
export const Comma = createToken({ name: 'Comma', pattern: /,/ });
export const Dot = createToken({ name: 'Dot', pattern: /\./ });

// Identifier comes LAST so keywords (True/False/Null) win when the input
// matches `true` / `false` / `null` exactly. chevrotain's longest-match
// resolves ties by declaration order: earlier wins.
export const Identifier = createToken({ name: 'Identifier', pattern: /[A-Za-z_]\w*/ });

// Whitespace is captured but dropped before the parser sees it.
export const WhiteSpace = createToken({
  name: 'WhiteSpace',
  pattern: /\s+/,
  group: Lexer.SKIPPED,
});

/**
 * Token order locks longest-match behavior. WhiteSpace can sit anywhere
 * (it's SKIPPED), but keywords MUST precede Identifier, and multi-char
 * operators MUST precede their single-char prefixes.
 */
export const allTokens = [
  WhiteSpace,
  StringLit,
  NumberLit,
  True,
  False,
  Null,
  EqEq,
  NotEq,
  Lte,
  Gte,
  Lt,
  Gt,
  AndAnd,
  OrOr,
  Bang,
  LParen,
  RParen,
  LBracket,
  RBracket,
  Comma,
  Dot,
  Identifier,
];

/**
 * Singleton Lexer instance — chevrotain perf guide recommends reuse across
 * tokenize() calls. The Lexer is stateless across calls; only its result is
 * per-invocation.
 */
export const lexer = new Lexer(allTokens);
