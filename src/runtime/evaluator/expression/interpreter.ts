/**
 * Tree-walking interpreter + sandbox + path resolver — Task H.1.4.
 *
 * Sandbox guarantees (pre-research §3.3):
 *   1. No string-eval / no dynamic Function-constructor — audit-grep
 *      invariant on this file (see pre-research §3.1 on why we reject
 *      Node's vm + the VM2 family).
 *   2. No prototype access — every path step uses `Object.hasOwn`, blocking
 *      reserved JS property names like the dunder-proto slot, the ctor
 *      slot, the proto slot, toString, etc.
 *   3. Depth cap 64 — guards against stack-overflow from pathological ASTs.
 *      Counted at each recursive `evaluate()` entry (depth + 1 per descent).
 *   4. Step cap 10_000 — guards against compute-bound DoS from compound
 *      expressions. Counted at every `evaluate()` call (before any branch).
 *   5. Allow-listed function dispatch only — `FUNCTIONS` registry lookup;
 *      missing names throw `InterpreterRuntimeError`. (H.1.5 populates the
 *      5 pure functions; H.1.4 ships the registry as an empty stub.)
 *   6. No filesystem / network / process / time / random access in any path.
 *   7. Comparison operators use STRICT equality per pre-research §12.3 lock
 *      — no `String()` coercion. `==` and `===` both lower to the same
 *      `BinaryOp.'=='` (lexer collapses `EqEq`); same for `!=` / `!==`.
 *
 * Errors fall into two classes — both are caught by the outer evaluator
 * driver (lands later in H.1.6) which converts to `false + warn`:
 *   - `InterpreterLimitError` — depth or step cap hit.
 *   - `InterpreterRuntimeError` — unknown function call (only runtime-
 *     reachable error in H.1.4; type-mismatches return `false`, not throw).
 *
 * Design comparison (pre-research §3.1): we use the Lua/Cerbos pattern of
 * runtime visit-counting rather than Cerbos's precomputed cost analysis
 * (simpler, equally safe for our size). We explicitly REJECT Node's `vm`
 * module + VM2 (CVE-2023-29017) — the tree-walking interpreter pattern is
 * the safe choice for in-process untrusted expression evaluation.
 */

import { assertNever, type ASTNode, type BinaryOp, type PathSegment } from './ast.js';
import { FUNCTIONS } from './functions.js';

/** AST-nesting depth cap. See pre-research §3.2. */
export const MAX_DEPTH = 64;
/** Per-eval node-visit cap. See pre-research §3.2. */
export const MAX_STEPS = 10_000;

/** Thrown when depth or step cap is exceeded. Caller converts to `false`. */
export class InterpreterLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InterpreterLimitError';
  }
}

/** Thrown for runtime conditions like unknown function names. */
export class InterpreterRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InterpreterRuntimeError';
  }
}

/**
 * Per-evaluation context. Pass a fresh `EvalCtx` per top-level evaluation —
 * `steps` is mutated to count every node visit across the whole tree.
 * `bindings` is a plain `Map` so author-supplied keys can't collide with
 * Object.prototype keys (a `Map<string, unknown>` doesn't share prototype
 * keys with the binding value lookups).
 */
export interface EvalCtx {
  bindings: Map<string, unknown>;
  /** Mutated per visit; `evaluate` throws `InterpreterLimitError` on overrun. */
  steps: number;
}

/**
 * Tree-walking evaluator. Returns the typed value of `node` under `ctx`.
 *
 * Recursion contract: increment `depth + 1` at every recursive call so the
 * depth cap measures AST nesting, not call-stack depth (these would diverge
 * if helpers like `resolvePath` recursed). Increment `ctx.steps` at the top
 * of each call before any branching so the step cap catches pathological
 * trees even when the work happens inside a binary's RHS.
 */
export function evaluate(node: ASTNode, ctx: EvalCtx, depth = 0): unknown {
  if (depth > MAX_DEPTH) throw new InterpreterLimitError(`depth>${MAX_DEPTH}`);
  if (++ctx.steps > MAX_STEPS) throw new InterpreterLimitError(`steps>${MAX_STEPS}`);

  switch (node.kind) {
    case 'literal':
      return node.value;
    case 'name':
      // `Map.get` returns undefined for missing keys — no prototype-chain
      // lookup. Reserved JS property names (the dunder-proto slot, ctor
      // slot, etc.) resolve to undefined unless the caller explicitly
      // `.set()` them (and even then they're ordinary string keys in the
      // Map, not prototype slots).
      return ctx.bindings.get(node.id);
    case 'path':
      return resolvePath(evaluate(node.target, ctx, depth + 1), node.segments);
    case 'call': {
      const fn = FUNCTIONS[node.name];
      if (!fn) throw new InterpreterRuntimeError(`unknown function: ${node.name}`);
      const args = node.args.map((a) => evaluate(a, ctx, depth + 1));
      return fn(...args);
    }
    case 'unary':
      // JS-truthy applied to the operand: `!0` is `true`, `!"" ` is `true`,
      // `!{}` is `false`. Spec test fixture confirms.
      return !evaluate(node.operand, ctx, depth + 1);
    case 'binary': {
      // Short-circuit AND / OR BEFORE evaluating RHS, per the test contract
      // that a throwing RHS must never fire when the LHS short-circuits.
      if (node.op === '&&') {
        const lhs = evaluate(node.lhs, ctx, depth + 1);
        return lhs ? evaluate(node.rhs, ctx, depth + 1) : lhs;
      }
      if (node.op === '||') {
        const lhs = evaluate(node.lhs, ctx, depth + 1);
        // Truthy-based short-circuit (matches JS `||` semantics, NOT `??`):
        // `0 || rhs` must evaluate rhs. eslint's prefer-nullish-coalescing
        // hint would silently change behavior — keep the ternary.
        // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- truthy-based short-circuit; nullish would change semantics.
        return lhs ? lhs : evaluate(node.rhs, ctx, depth + 1);
      }
      const lhs = evaluate(node.lhs, ctx, depth + 1);
      const rhs = evaluate(node.rhs, ctx, depth + 1);
      return applyCompare(node.op, lhs, rhs);
    }
    default:
      return assertNever(node);
  }
}

/**
 * Comparison dispatch. Strict equality per pre-research §12.3 (no `String()`
 * wrapping). Order/relational ops require BOTH operands to be numbers — type
 * mismatch returns `false` (fail-closed). The 6 ops here mirror the
 * non-short-circuit half of `BinaryOp` from ast.ts (8 ops total minus `&&`
 * and `||` handled inline above).
 */
function applyCompare(op: Exclude<BinaryOp, '&&' | '||'>, lhs: unknown, rhs: unknown): boolean {
  switch (op) {
    case '==':
      return lhs === rhs;
    case '!=':
      return lhs !== rhs;
    case '<':
      return typeof lhs === 'number' && typeof rhs === 'number' && lhs < rhs;
    case '<=':
      return typeof lhs === 'number' && typeof rhs === 'number' && lhs <= rhs;
    case '>':
      return typeof lhs === 'number' && typeof rhs === 'number' && lhs > rhs;
    case '>=':
      return typeof lhs === 'number' && typeof rhs === 'number' && lhs >= rhs;
    default:
      return assertNever(op);
  }
}

/**
 * Walk `segments` against `root`. Null/undefined chains short-circuit to
 * `undefined`. Property access goes through `Object.hasOwn` to block
 * prototype-pollution paths (reserved JS slots like dunder-proto, ctor,
 * etc.). Numeric `length` is the one non-own getter we surface —
 * preserves G.5 behavior for `matches.length > 0` clauses that pre-date
 * the chevrotain grammar.
 */
function resolvePath(root: unknown, segments: PathSegment[]): unknown {
  let cur: unknown = root;
  for (const seg of segments) {
    if (cur === null || cur === undefined) return undefined;
    if (seg.kind === 'prop') {
      // `length` special-case: Array.length + String.length are NOT own
      // properties — they're getter accessors on the prototype. Without
      // this branch every `matches.length > 0` clause silently returns
      // `false` and existing G.5 skills regress.
      if (seg.name === 'length' && (Array.isArray(cur) || typeof cur === 'string')) {
        cur = (cur as { length: number }).length;
        continue;
      }
      if (typeof cur !== 'object' || !Object.hasOwn(cur, seg.name)) {
        return undefined;
      }
      cur = (cur as Record<string, unknown>)[seg.name];
      continue;
    }
    // seg.kind === 'index'
    if (typeof seg.value === 'number') {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[seg.value];
      continue;
    }
    // String index — same own-property check as prop access.
    if (typeof cur !== 'object' || !Object.hasOwn(cur, seg.value)) {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[seg.value];
  }
  return cur;
}
