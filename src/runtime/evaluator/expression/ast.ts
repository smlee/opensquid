/**
 * AST + CST→AST visitor — Task H.1.3 (chevrotain v11 visitor).
 *
 * Lowers the CST from parser.ts (H.1.2) into a 6-kind discriminated union
 * (literal | name | path | call | unary | binary). Switches over
 * `ASTNode['kind']` MUST end with `assertNever(node)` so a new kind breaks
 * typecheck at every callsite. Nodes carry `offset: number` from the
 * originating token's `startOffset`; binary nodes inherit the LHS offset so
 * left-folded chains point at the leftmost operand. orExpr/andExpr fold
 * left-to-right (`((a&&b)&&c)`). Strings strip outer quotes then process
 * `\"` `\\` `\n` `\t` `\r` (unknown escapes pass through). `validateVisitor()`
 * is REQUIRED — without it, visitor-method typos silently return undefined.
 */

import type { CstNode, IToken } from 'chevrotain';

import { parserInstance } from './parser.js';

// ---- AST types -----------------------------------------------------------

export type BinaryOp = '==' | '!=' | '<' | '<=' | '>' | '>=' | '&&' | '||';

export type PathSegment =
  | { kind: 'prop'; name: string }
  | { kind: 'index'; value: number | string };

export type ASTNode =
  | { kind: 'literal'; value: string | number | boolean | null; offset: number }
  | { kind: 'name'; id: string; offset: number }
  | { kind: 'path'; target: ASTNode; segments: PathSegment[]; offset: number }
  | { kind: 'call'; name: string; args: ASTNode[]; offset: number }
  | { kind: 'unary'; op: '!'; operand: ASTNode; offset: number }
  | { kind: 'binary'; op: BinaryOp; lhs: ASTNode; rhs: ASTNode; offset: number };

/** Throw on unhandled discriminator — call from any switch over `ASTNode['kind']`. */
export function assertNever(x: never): never {
  throw new Error(`Unhandled AST kind: ${JSON.stringify(x)}`);
}

// ---- CST visitor ---------------------------------------------------------

// Chevrotain's `ctx` — keyed by LABEL ('lhs'/'rhs'/'arg'), sub-rule name, or
// token-type name (see parser.ts header for the full navigation contract).
type Ctx = Record<string, (CstNode | IToken)[] | undefined>;

const BaseVisitor = parserInstance.getBaseCstVisitorConstructor();

class CstToAstVisitor extends BaseVisitor {
  constructor() {
    super();
    this.validateVisitor();
  }

  // Typed wrappers around chevrotain's `any`-typed `visit()` — confine the
  // unsafe surface to two callees. `no-unsafe-return` disabled at each
  // return; per-method return annotation provides downstream type narrowing.
  private visitNode(child: CstNode[] | CstNode | undefined): ASTNode {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- chevrotain visit() returns any.
    return this.visit(child as CstNode[]);
  }
  private visitSeg(child: CstNode): PathSegment {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- chevrotain visit() returns any.
    return this.visit(child);
  }

  expression(ctx: Ctx): ASTNode {
    return this.visitNode(ctx.orExpr as CstNode[]);
  }
  orExpr(ctx: Ctx): ASTNode {
    return this.foldBinary(ctx, '||');
  }
  andExpr(ctx: Ctx): ASTNode {
    return this.foldBinary(ctx, '&&');
  }

  // Shared left-fold for orExpr/andExpr (both have lhs + MANY rhs).
  private foldBinary(ctx: Ctx, op: '||' | '&&'): ASTNode {
    let acc = this.visitNode(ctx.lhs as CstNode[]);
    const rhs = ctx.rhs as CstNode[] | undefined;
    if (rhs) {
      for (const r of rhs) {
        acc = { kind: 'binary', op, lhs: acc, rhs: this.visitNode(r), offset: acc.offset };
      }
    }
    return acc;
  }

  notExpr(ctx: Ctx): ASTNode {
    const operand = this.visitNode(ctx.compareExpr as CstNode[]);
    const bang = (ctx.Bang as IToken[] | undefined)?.[0];
    return bang ? { kind: 'unary', op: '!', operand, offset: bang.startOffset } : operand;
  }

  compareExpr(ctx: Ctx): ASTNode {
    const lhs = this.visitNode(ctx.lhs as CstNode[]);
    const r = ctx.rhs as CstNode[] | undefined;
    if (!r) return lhs;
    const op = pickCompareOp(ctx);
    return { kind: 'binary', op, lhs, rhs: this.visitNode(r), offset: lhs.offset };
  }

  primary(ctx: Ctx): ASTNode {
    const sub = (ctx.expression ?? ctx.literal ?? ctx.callOrPath) as CstNode[] | undefined;
    if (!sub) throw new Error('primary: no alternative matched (parser invariant violated)');
    return this.visitNode(sub);
  }

  callOrPath(ctx: Ctx): ASTNode {
    const id = (ctx.Identifier as IToken[])[0]!;
    const offset = id.startOffset;
    if (ctx.LParen) {
      const args = ((ctx.arg as CstNode[] | undefined) ?? []).map((a) => this.visitNode(a));
      return { kind: 'call', name: id.image, args, offset };
    }
    const segs = ctx.pathSegment as CstNode[] | undefined;
    const name: ASTNode = { kind: 'name', id: id.image, offset };
    if (!segs?.length) return name;
    return { kind: 'path', target: name, segments: segs.map((s) => this.visitSeg(s)), offset };
  }

  pathSegment(ctx: Ctx): PathSegment {
    if (ctx.Dot) return { kind: 'prop', name: (ctx.Identifier as IToken[])[0]!.image };
    const num = (ctx.NumberLit as IToken[] | undefined)?.[0];
    if (num) return { kind: 'index', value: Number(num.image) };
    const str = (ctx.StringLit as IToken[] | undefined)?.[0];
    if (str) return { kind: 'index', value: parseStringLit(str.image) };
    throw new Error('pathSegment: no alternative matched (parser invariant violated)');
  }

  literal(ctx: Ctx): ASTNode {
    if (ctx.StringLit) return litNode(ctx.StringLit[0] as IToken, parseStringLit);
    if (ctx.NumberLit) return litNode(ctx.NumberLit[0] as IToken, Number);
    if (ctx.True) return litNode(ctx.True[0] as IToken, () => true);
    if (ctx.False) return litNode(ctx.False[0] as IToken, () => false);
    if (ctx.Null) return litNode(ctx.Null[0] as IToken, () => null);
    throw new Error('literal: no alternative matched (parser invariant violated)');
  }
}

function litNode(t: IToken, project: (img: string) => string | number | boolean | null): ASTNode {
  return { kind: 'literal', value: project(t.image), offset: t.startOffset };
}

// Pick the one compare op token populated under compareExpr's children.
// Exactly one of the six is present when ctx.rhs is set (parser invariant).
function pickCompareOp(ctx: Ctx): BinaryOp {
  if (ctx.EqEq) return '==';
  if (ctx.NotEq) return '!=';
  if (ctx.Lte) return '<=';
  if (ctx.Gte) return '>=';
  if (ctx.Lt) return '<';
  if (ctx.Gt) return '>';
  throw new Error('compareExpr: rhs present but no operator token (parser invariant violated)');
}

// Strip outer quotes + process JSON-ish escapes (\" \\ \n \t \r). Unknown
// escapes pass through as the escaped character.
const ESC: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' };
function parseStringLit(raw: string): string {
  const inner = raw.slice(1, -1);
  let out = '';
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!;
    if (c !== '\\' || i === inner.length - 1) {
      out += c;
      continue;
    }
    const next = inner[++i]!;
    out += ESC[next] ?? next;
  }
  return out;
}

const visitorInstance = new CstToAstVisitor();

/** Lower a parser CST into an AST. Throws if the CST shape is malformed. */
export function cstToAst(cst: CstNode): ASTNode {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- chevrotain visit() returns any.
  return visitorInstance.visit(cst);
}
