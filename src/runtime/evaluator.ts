/**
 * Process evaluator — interpreter loop for `ProcessStep[]`.
 *
 * A rule is a process: a flat sequence of primitive calls (Task 1.1 types,
 * Task 1.2 registry). This module walks the array, dispatches each step
 * through the registry, manages variable bindings (`as:` writes), evaluates
 * `if:` conditions, applies `on_empty:` early-exit policy, and recognises the
 * `verdict` primitive as the terminal step. The output is a `RuleResult`.
 *
 * What the evaluator deliberately is NOT:
 *
 *   - A general-purpose expression language. `if:` accepts ONLY bare-name
 *     truthiness (`hit`) and simple equality (`x == "FOO"`). Anything else
 *     resolves to `false` with a console warning. No `eval()` or
 *     `new Function()` — audit-grepped. Future expression features ship as
 *     a Phase 2 task, not a string-eval here.
 *
 *   - A template engine. `{{name}}` interpolation runs against string
 *     `args` values only; nested objects with template strings are NOT
 *     walked in Phase 1. Unbound variables substitute the empty string.
 *
 *   - A scheduler. Steps run strictly in order. Concurrency would need a
 *     primitive that fans out internally; the interpreter itself is serial.
 *
 * Purity: no module-level state. All variable scope lives in `ctx.bindings`,
 * which the caller owns. A second `evaluateProcess` call against the same
 * steps with a fresh ctx must produce the same result — tests rely on this.
 *
 * Imports from: runtime/types.ts, runtime/result.ts, functions/registry.ts.
 * Imported by: runtime/ (rule dispatcher in later phases).
 */

import type { FunctionRegistry, EvalCtx } from '../functions/registry.js';

import type { ProcessStep, RuleResult, Verdict } from './types.js';

// ---------------------------------------------------------------------------
// evaluateProcess — drive a step array against a Context + Registry
//
// Step lifecycle (per task spec):
//
//   1. Skip if `step.if` evaluates false.
//   2. Interpolate `step.args` (substitute `{{name}}` from bindings).
//   3. Call `registry.call(step.call, interpolatedArgs, ctx)`.
//   4. If !result.ok → return `{ kind: 'error', step: i, error: msg }`.
//   5. If `step.call === 'verdict'` and value is a Verdict → terminal verdict.
//   6. If empty + on_empty === 'pass' → terminal `no_verdict`.
//   7. If empty + on_empty === 'block' → terminal block verdict (auto msg).
//   8. If on_empty === 'continue' → fall through.
//   9. If `step.as` set → bind result.value to that name.
//  10. Continue to next step.
//
// After all steps: `{ kind: 'no_verdict' }`. The caller decides what a
// no-verdict outcome means (track_check pass, destination_check no-op, etc.).
// ---------------------------------------------------------------------------

export async function evaluateProcess(
  steps: ProcessStep[],
  ctx: EvalCtx,
  registry: FunctionRegistry,
): Promise<RuleResult> {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step) continue; // noUncheckedIndexedAccess guard

    // 1. Conditional skip
    if (step.if !== undefined && !evalCondition(step.if, ctx.bindings)) {
      continue;
    }

    // 2. Interpolate `{{var}}` in string args
    const interpolatedArgs = interpolateArgs(step.args ?? {}, ctx.bindings);

    // 3. Dispatch through the registry
    const result = await registry.call(step.call, interpolatedArgs, ctx);

    // 4. Primitive failed — surface step index for diagnostics
    if (!result.ok) {
      return { kind: 'error', error: result.error.message, step: i };
    }

    // 5. `verdict` primitive returns a Verdict shape → terminal
    if (step.call === 'verdict' && isVerdict(result.value)) {
      return { kind: 'verdict', verdict: result.value };
    }

    // 6-8. on_empty policy when the call produced nothing useful
    if (isEmpty(result.value) && step.on_empty !== undefined) {
      if (step.on_empty === 'pass') {
        return { kind: 'no_verdict' };
      }
      if (step.on_empty === 'block') {
        return {
          kind: 'verdict',
          verdict: { level: 'block', message: `Step ${i} returned empty` },
        };
      }
      // 'continue' → fall through to binding + next step
    }

    // 9. Bind result to a named variable for later `if` / `args` references
    if (step.as !== undefined) {
      ctx.bindings.set(step.as, result.value);
    }
  }
  return { kind: 'no_verdict' };
}

// ---------------------------------------------------------------------------
// evalCondition — safe `if:` expression evaluator (NO eval())
//
// Phase 1 deliberately accepts only two forms:
//
//   - Bare-name truthiness: `hit` → Boolean(bindings.get('hit'))
//   - Simple equality:      `x == "FOO"` → String(bindings.get('x')) === 'FOO'
//
// Anything else (operators &&, ||, function calls, parens, numbers as RHS)
// returns false and emits a console warning. The warning is intentionally
// loud during pack-author development; Task 1.10+ wires a real logger and
// surfaces these via the channel-routing pipeline. Until then `console.warn`
// is the agreed placeholder.
//
// Audit grep: this file contains zero matches for `eval(` or `new Function`.
// ---------------------------------------------------------------------------

const EQ_PATTERN = /^(\w+)\s*==\s*"([^"]+)"$/;
const BARE_PATTERN = /^\w+$/;

function evalCondition(expr: string, bindings: Map<string, unknown>): boolean {
  const trimmed = expr.trim();

  const eqMatch = EQ_PATTERN.exec(trimmed);
  if (eqMatch) {
    const name = eqMatch[1];
    const value = eqMatch[2];
    if (name === undefined || value === undefined) return false;
    return String(bindings.get(name)) === value;
  }

  if (BARE_PATTERN.test(trimmed)) {
    return Boolean(bindings.get(trimmed));
  }

  // Unsupported expression — refuse to guess. Loud enough that pack authors
  // notice during dev; the runtime never silently mis-evaluates a condition.
  console.warn(
    `[opensquid:evaluator] Unsupported if-expression: ${JSON.stringify(expr)}. ` +
      `Phase 1 supports bare-name truthiness ("hit") or simple equality ("x == \\"FOO\\").`,
  );
  return false;
}

// ---------------------------------------------------------------------------
// interpolateArgs — `{{name}}` substitution in string args
//
// Walks the top level of `args`. Only string values are scanned; non-string
// values (numbers, booleans, nested objects, arrays) pass through untouched.
// This is a deliberate Phase 1 limitation — a recursive walker risks
// over-substituting into payloads that happen to contain `{{...}}` literals
// (regex args, code-content args). Skills needing deep interpolation should
// pre-bind via `as:` then reference the bound name directly.
//
// Unbound variable → empty string. The pack author's `if:` step before the
// `args:` is the right place to gate on whether a binding actually exists.
// ---------------------------------------------------------------------------

const TEMPLATE_DETECT = /\{\{\s*\w+\s*\}\}/;
const TEMPLATE_REPLACE = /\{\{\s*(\w+)\s*\}\}/g;

function interpolateArgs(
  args: Record<string, unknown>,
  bindings: Map<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string' && TEMPLATE_DETECT.test(v)) {
      out[k] = v.replace(TEMPLATE_REPLACE, (_match, name: string) =>
        stringifyBinding(bindings.get(name)),
      );
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Convert a binding value into a string for `{{var}}` substitution.
 *
 * Phase 1 policy: primitive (string/number/boolean/bigint) → its `String()`
 * form; null/undefined/object/array → empty string. Objects deliberately
 * resolve to `''` instead of `[object Object]` — pack authors who want a
 * structured payload should pass it as a real arg, not a template.
 */
function stringifyBinding(v: unknown): string {
  if (v === null || v === undefined) return '';
  switch (typeof v) {
    case 'string':
      return v;
    case 'number':
    case 'boolean':
    case 'bigint':
      return String(v);
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// isEmpty — falsy-aware empty detection for `on_empty:` policy
//
// "Empty" here is narrower than JavaScript's `falsy`. A primitive that
// returns 0, false, or NaN has produced a *meaningful* value and should bind
// normally. Only null/undefined, the empty array, and the empty string are
// treated as "nothing useful to act on" — the three shapes a search/filter
// primitive returns when it found nothing.
// ---------------------------------------------------------------------------

function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (Array.isArray(v) && v.length === 0) return true;
  if (typeof v === 'string' && v.length === 0) return true;
  return false;
}

// ---------------------------------------------------------------------------
// isVerdict — TS type predicate for the `verdict` primitive's return shape
//
// The `verdict` primitive (not yet registered as of Task 1.3) is the
// canonical terminal step: when its return value matches `Verdict`, the
// evaluator stops the loop and returns it. The runtime Zod schema for
// Verdict lives in runtime/types.ts; the type predicate here is a
// structural check ahead of Zod (the registry's argSchema validates inputs,
// not outputs — output validation would belong inside the `verdict`
// primitive itself when it lands in a later task).
// ---------------------------------------------------------------------------

function isVerdict(v: unknown): v is Verdict {
  if (typeof v !== 'object' || v === null) return false;
  if (!('level' in v) || !('message' in v)) return false;
  return typeof v.level === 'string' && typeof v.message === 'string';
}
