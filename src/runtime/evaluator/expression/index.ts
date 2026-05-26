/**
 * Public `evalCondition` entry — Task H.1.6 (integration cutover).
 *
 * Threads the H.1.1–H.1.5 substrate (lexer → parser → AST visitor →
 * interpreter, with an LRU parse cache) into a single boolean-returning
 * function that the wider runtime can call as a drop-in replacement for the
 * old 5-regex `evalCondition` in `evaluator.ts`. All five regex constants
 * (`EQ_PATTERN`, `BARE_PATTERN`, `NUM_CMP_PATTERN`, `BOOL_CMP_PATTERN`,
 * `STR_PATH_EQ_PATTERN`) and the `resolveNumericPath` helper are deleted
 * upstream — the chevrotain grammar covers every form they recognised, plus
 * the new forms (`||`, `!`, parens, deeper paths, index access, function
 * calls) that the regex set was unable to express.
 *
 * Locked decisions codified here (pre-research §12, this is the cutover
 * commit that ships them):
 *
 *   - §12.2 — empty `if:` returns `true` (was silent `false` + warn). Treat
 *     a present-but-empty predicate as equivalent to "no `if:` field" so
 *     pack-author trailing-whitespace YAML doesn't accidentally skip steps.
 *   - §12.3 — comparison is STRICT equality. `1 == "1"` is `false`. No
 *     `String()` wrapping. The interpreter's `applyCompare` already enforces
 *     this; `evalCondition` does not re-coerce.
 *   - §12.4 — `phases != "complete"` (and any other `!=` form) is now valid
 *     grammar. The `phase-logged-before-commit` workflow rule that was a
 *     silent no-op for the entire G-track lifetime starts firing for real.
 *   - The 5-regex grammar is replaced wholesale; this module is the only
 *     `if:`-parsing surface in the runtime.
 *
 * Error model (3 tiers, all fail-closed → `false` + `console.warn`):
 *
 *   1. Lex error — input has a character the lexer doesn't recognise
 *      (e.g. `'== ='` — `=` alone is not a valid token; only `EqEq`/`NotEq`
 *      consume `==`/`===`/`!=`/`!==`).
 *   2. Parse error — token stream doesn't match the grammar (e.g. `'a &&'`,
 *      `'(a || b'`).
 *   3. Interpreter error — `InterpreterLimitError` (depth>64 or steps>10k)
 *      or `InterpreterRuntimeError` (unknown function name).
 *
 * The 3-tier model means `console.warn` always names the originating layer,
 * which makes "why did my `if:` silently skip?" diagnosable in one read.
 *
 * Parse cache integration: cache key = trimmed input string; cache value =
 * the cstToAst result. Cache miss runs lex+parse+ast; cache hit jumps
 * straight to evaluate. Setting on miss is critical — the spec's code shape
 * shows `getCached(trimmed) ?? parse(trimmed)` but omits the `setCached`,
 * which is a one-line bug that would make every call a cache miss.
 *
 * `parseExpression()` is the parse-only sibling export, exposed for H.2's
 * Zod refinement on the `if:` schema field. It throws on any of the 3 error
 * tiers (caller wraps in try/catch and surfaces via Zod's refinement
 * message). The empty-string case is also a throw here — load-time
 * validation has already established that the field is present; an empty
 * predicate at load-time is a YAML authoring mistake worth surfacing, even
 * though runtime semantics treat it as `true`.
 *
 * Imports from: `./lexer.js`, `./parser.js`, `./ast.js`, `./interpreter.js`,
 *   `./cache.js`.
 * Imported by: `src/runtime/evaluator.ts` (the one-line shim that the old
 *   `evalCondition` collapses to); H.2's `src/packs/schemas/skill.ts`
 *   refinement will import `parseExpression` from here.
 */

import { cstToAst, type ASTNode } from './ast.js';
import { getCached, setCached } from './cache.js';
import { evaluate, InterpreterLimitError, InterpreterRuntimeError } from './interpreter.js';
import { lexer } from './lexer.js';
import { parseToCst } from './parser.js';

/**
 * Evaluate an `if:` expression against the supplied bindings.
 *
 * Returns `true` to mean "run the step", `false` to mean "skip the step".
 * Errors at every layer fail closed to `false` + `console.warn` so a broken
 * predicate never silently mis-fires a verdict; the warn surfaces the failure
 * during pack-author development.
 */
export function evalCondition(expr: string, bindings: Map<string, unknown>): boolean {
  const trimmed = expr.trim();
  // Per pre-research §12.2 lock: empty `if:` (or whitespace-only) is treated
  // as a present-but-trivial truthy predicate. Symmetric with the absent-
  // field case at evaluator.ts:169 which already short-circuits.
  if (trimmed === '') return true;

  let ast = getCached(trimmed);
  if (!ast) {
    const lex = lexer.tokenize(trimmed);
    if (lex.errors.length > 0) {
      console.warn(
        `[opensquid:evaluator] lex error on ${JSON.stringify(expr)}: ${lex.errors[0]!.message}`,
      );
      return false;
    }
    const { cst, errors } = parseToCst(lex);
    if (errors.length > 0) {
      console.warn(
        `[opensquid:evaluator] parse error on ${JSON.stringify(expr)}: ${errors[0]!.message}`,
      );
      return false;
    }
    try {
      ast = cstToAst(cst);
    } catch (e) {
      console.warn(
        `[opensquid:evaluator] AST error on ${JSON.stringify(expr)}: ${(e as Error).message}`,
      );
      return false;
    }
    setCached(trimmed, ast);
  }

  try {
    return Boolean(evaluate(ast, { bindings, steps: 0 }));
  } catch (e) {
    if (e instanceof InterpreterLimitError) {
      console.warn(
        `[opensquid:evaluator] interpreter limit on ${JSON.stringify(expr)}: ${e.message}`,
      );
    } else if (e instanceof InterpreterRuntimeError) {
      console.warn(`[opensquid:evaluator] runtime error on ${JSON.stringify(expr)}: ${e.message}`);
    } else {
      console.warn(
        `[opensquid:evaluator] unexpected error on ${JSON.stringify(expr)}: ${(e as Error).message}`,
      );
    }
    return false;
  }
}

/**
 * Parse-only entry for load-time validation (H.2 Zod refinement).
 *
 * Throws on any of the 3 error tiers (lex / parse / AST). Callers wrap in
 * try/catch and surface the message via `z.string().refine()` so pack-load
 * errors point at the offending `if:` clause via the source-path prefix
 * already attached by `parseYamlFile`.
 *
 * Empty-string here is treated as an authoring mistake (the load-time
 * surface should reject empties — only the runtime surface is forgiving per
 * §12.2). Callers that want the runtime-style "empty is true" behavior
 * should guard at the caller, not here.
 */
export function parseExpression(expr: string): ASTNode {
  const trimmed = expr.trim();
  if (trimmed === '') throw new Error('empty expression');
  const lex = lexer.tokenize(trimmed);
  if (lex.errors.length > 0) throw new Error(lex.errors[0]!.message);
  const { cst, errors } = parseToCst(lex);
  if (errors.length > 0) throw new Error(errors[0]!.message);
  return cstToAst(cst);
}
