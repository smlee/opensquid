/**
 * Expression parser — Task H.1.2 (chevrotain v11 CstParser).
 *
 * Builds a CST from lexer.ts (H.1.1) tokens; CST→AST visitor lives in H.1.3.
 *
 * Grammar (9 rules — precedence via nesting depth, low→high `||<&&<!<cmp`):
 *   expression  := orExpr
 *   orExpr      := andExpr ( '||' andExpr )*
 *   andExpr     := notExpr ( '&&' notExpr )*
 *   notExpr     := '!'? compareExpr
 *   compareExpr := primary ( (==|!=|<|<=|>|>=) primary )?
 *   primary     := '(' expression ')' | literal | callOrPath
 *   callOrPath  := Identifier ( '(' args ')' | pathSegment* )?
 *   pathSegment := '.' Identifier | '[' (NumberLit | StringLit) ']'
 *   literal     := StringLit | NumberLit | True | False | Null
 *
 * Left-associativity via `MANY`: chevrotain LL(k) rejects left-recursion at
 * `performSelfAnalysis()`. The idiomatic shape `lhs ( OP rhs )*` lets the
 * visitor left-fold the children. No chained comparison: single `OPTION` on
 * compareExpr; `a < b < c` surfaces as a parse error under recoveryEnabled:false.
 *
 * Singleton per chevrotain perf guide — one instance reused (state reset via
 * `parser.input = tokens`). Fresh instance per call would re-run
 * performSelfAnalysis() (~5ms). Audit-grep `new ExpressionParser` = 1 match.
 *
 * LL(1) disjointness audit — all OR/OPTION sites have disjoint first-tokens:
 * primary {LParen|literal|Identifier}; callOrPath OPTION {LParen|Dot/LBracket};
 * pathSegment {Dot|LBracket}; literal {5 distinct kinds}; compareExpr {6 ops}.
 *
 * CST navigation hints for H.1.3 visitor:
 *   - LABEL'd sub-rules live under `children.lhs`/`children.rhs`;
 *     un-labeled sub-rules use the sub-rule name as the key.
 *   - `MANY` collects same-LABEL children into an array (e.g.
 *     `orExpr.children.rhs` is `CstNode[]` length 0..N).
 *   - `callOrPath.children` has `Identifier` (always) plus either
 *     `LParen`+`arg[]`+`RParen` (call) or `pathSegment[]` (path). Distinguish
 *     by presence of `LParen`. Args use `LABEL:'arg'` →
 *     `children.arg` is `CstNode[]` of expressions.
 *
 * Pinned to chevrotain ^11.0.0 — same engine constraint as lexer.ts.
 */

import { CstParser, type CstNode, type IToken } from 'chevrotain';

import {
  allTokens,
  AndAnd,
  Bang,
  Comma,
  Dot,
  EqEq,
  False,
  Gt,
  Gte,
  Identifier,
  LBracket,
  LParen,
  Lt,
  Lte,
  NotEq,
  Null,
  NumberLit,
  OrOr,
  RBracket,
  RParen,
  StringLit,
  True,
} from './lexer.js';

class ExpressionParser extends CstParser {
  constructor() {
    super(allTokens, { recoveryEnabled: false });
    this.performSelfAnalysis();
  }

  public expression = this.RULE('expression', () => {
    this.SUBRULE(this.orExpr);
  });

  private orExpr = this.RULE('orExpr', () => {
    this.SUBRULE(this.andExpr, { LABEL: 'lhs' });
    this.MANY(() => {
      this.CONSUME(OrOr);
      this.SUBRULE2(this.andExpr, { LABEL: 'rhs' });
    });
  });

  private andExpr = this.RULE('andExpr', () => {
    this.SUBRULE(this.notExpr, { LABEL: 'lhs' });
    this.MANY(() => {
      this.CONSUME(AndAnd);
      this.SUBRULE2(this.notExpr, { LABEL: 'rhs' });
    });
  });

  private notExpr = this.RULE('notExpr', () => {
    this.OPTION(() => this.CONSUME(Bang));
    this.SUBRULE(this.compareExpr);
  });

  private compareExpr = this.RULE('compareExpr', () => {
    this.SUBRULE(this.primary, { LABEL: 'lhs' });
    this.OPTION(() => {
      this.OR([
        { ALT: () => this.CONSUME(EqEq) },
        { ALT: () => this.CONSUME(NotEq) },
        { ALT: () => this.CONSUME(Lte) },
        { ALT: () => this.CONSUME(Gte) },
        { ALT: () => this.CONSUME(Lt) },
        { ALT: () => this.CONSUME(Gt) },
      ]);
      this.SUBRULE2(this.primary, { LABEL: 'rhs' });
    });
  });

  private primary = this.RULE('primary', () => {
    this.OR([
      {
        ALT: () => {
          this.CONSUME(LParen);
          this.SUBRULE(this.expression);
          this.CONSUME(RParen);
        },
      },
      { ALT: () => this.SUBRULE(this.literal) },
      { ALT: () => this.SUBRULE(this.callOrPath) },
    ]);
  });

  private callOrPath = this.RULE('callOrPath', () => {
    this.CONSUME(Identifier);
    this.OPTION(() => {
      this.OR([
        // call: `name(args)` — distinguished by leading LParen in children.
        {
          ALT: () => {
            this.CONSUME(LParen);
            this.OPTION1(() => {
              this.SUBRULE(this.expression, { LABEL: 'arg' });
              this.MANY(() => {
                this.CONSUME(Comma);
                this.SUBRULE2(this.expression, { LABEL: 'arg' });
              });
            });
            this.CONSUME(RParen);
          },
        },
        { ALT: () => this.MANY1(() => this.SUBRULE(this.pathSegment)) },
      ]);
    });
  });

  private pathSegment = this.RULE('pathSegment', () => {
    this.OR([
      {
        ALT: () => {
          this.CONSUME(Dot);
          this.CONSUME(Identifier);
        },
      },
      {
        ALT: () => {
          this.CONSUME(LBracket);
          this.OR1([
            { ALT: () => this.CONSUME(NumberLit) },
            { ALT: () => this.CONSUME(StringLit) },
          ]);
          this.CONSUME(RBracket);
        },
      },
    ]);
  });

  private literal = this.RULE('literal', () => {
    this.OR([
      { ALT: () => this.CONSUME(StringLit) },
      { ALT: () => this.CONSUME(NumberLit) },
      { ALT: () => this.CONSUME(True) },
      { ALT: () => this.CONSUME(False) },
      { ALT: () => this.CONSUME(Null) },
    ]);
  });
}

// Singleton per chevrotain perf guide.
const parserInstance = new ExpressionParser();

/** Parse error — `offset` is start-offset of the offending token (-1 if none). */
export interface ParseError {
  message: string;
  offset: number;
}

/** Result of a parse attempt — cst always present (may be partial on error). */
export interface ParseResult {
  cst: CstNode;
  errors: ParseError[];
}

/**
 * Parse a token stream into a CST. Caller invokes the lexer first and passes
 * the `{ tokens }` result (matches `ILexingResult` shape so callers can pass
 * `lexer.tokenize(input)` directly). recoveryEnabled:false means we stop at
 * the first error and surface it via the snapshot below.
 */
export function parseToCst(tokens: { tokens: IToken[] }): ParseResult {
  parserInstance.input = tokens.tokens;
  const cst = parserInstance.expression();
  const errors: ParseError[] = parserInstance.errors.map((e) => ({
    message: e.message,
    offset: e.token?.startOffset ?? -1,
  }));
  return { cst, errors };
}

// Exposed for tests that want to reference the singleton (the import itself
// proves performSelfAnalysis() completed without throwing at module load).
export { parserInstance };
