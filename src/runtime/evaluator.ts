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
 *   - A string-eval engine. `if:` parsing is delegated to the chevrotain
 *     grammar in `runtime/evaluator/expression/index.ts` (H.1.6 cutover);
 *     this module never sees raw expression strings beyond the one-line
 *     delegate at the bottom of the file. No `eval()` / `new Function()`
 *     anywhere — audit-grepped on both this file and the expression dir.
 *     The grammar supports logical ops (`||`, `&&`, `!`), parens, dotted
 *     and bracket paths, function calls (5 allow-listed: `len`, `contains`,
 *     `match`, `startsWith`, `endsWith`), and strict equality.
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
 * Durable execution (DURABLE.2):
 *
 *   When the caller passes a `checkpoint` option containing a CheckpointStore
 *   + runId, every step whose primitive declares `durable: true` is wrapped:
 *
 *     1. Resolve `(call, interpolatedArgs)` → `inputsHash` via canonical JSON
 *     2. Look up `checkpoints[runId][stepIdx]` (prefetched at entry)
 *     3. If the row exists, has `status: 'completed'`, and `inputsHash`
 *        matches → restore the row's `outputs` into `ctx.bindings[step.as]`,
 *        skip the primitive call entirely
 *     4. Else → execute the primitive, then `store.append(...)` the row
 *
 *   Non-durable primitives bypass the wrap entirely (no hash, no lookup, no
 *   write) — the audit guarantee is that the only durable-execution overhead
 *   on cheap primitives is one `if (def.durable)` branch per step.
 *
 *   Errored primitive results write a row with `status: 'errored'` so the
 *   resumer can re-run that step on the next pass. The evaluator still
 *   returns the error to the caller — the checkpoint write is best-effort
 *   accounting, not a swallowed failure.
 *
 * Memoization (DURABLE.3):
 *
 *   When the caller passes a `memo` option containing a MemoCache, primitives
 *   that declare `memoizable: true` (DURABLE.2 metadata) get an extra layer
 *   AFTER the checkpoint-hit branch but BEFORE the primitive invoke:
 *
 *     1. Run the same `inputsHash` derivation.
 *     2. If checkpoint hit → use it (covers same-run resume, exact-input).
 *     3. Else look up `memoCache.get(fn, inputsHash)` — cross-run cache.
 *     4. On memo hit → return value, write a checkpoint row (so a resume
 *        of THIS run remembers the step) but DON'T re-invoke the primitive.
 *     5. On memo miss → singleflight the invocation so 100 concurrent
 *        misses on the same key → 1 primitive call. Set the cache + write
 *        the checkpoint inside the singleflight body.
 *
 *   Memoization fires ONLY for `memoizable: true` primitives. Cheap
 *   non-memoizable primitives (state_lookup, verdict, match_regex) flow
 *   straight through — same as in DURABLE.2.
 *
 *   TTLs are caller-provided (per-primitive class defaults live in the
 *   caller's `memo.ttlForFn(fn)` callback). The evaluator never invents a
 *   TTL of its own — keeping the TTL policy with the caller lets pack
 *   authors override per-fn defaults.
 *
 * Imports from: runtime/types.ts, runtime/result.ts, functions/registry.ts,
 *   runtime/durable/checkpoint_store.ts, runtime/durable/canonical_json.ts,
 *   runtime/durable/run_id.ts, runtime/durable/memo_cache.ts.
 * Imported by: runtime/ (rule dispatcher in later phases).
 */

import type { FunctionRegistry, EvalCtx } from '../functions/registry.js';

import { canonicalJsonStringify } from './durable/canonical_json.js';
import type { CheckpointRow, CheckpointStore } from './durable/checkpoint_store.js';
import type { MemoCache } from './durable/memo_cache.js';
import { sha256Hex } from './durable/run_id.js';
import { evalCondition } from './evaluator/expression/index.js';
import type { ProcessStep, RuleResult, Verdict } from './types.js';

// ---------------------------------------------------------------------------
// CheckpointOptions — wire the durable-execution layer into evaluateProcess.
//
// `store` + `runId` are the only two values the evaluator needs from the
// caller. The caller (rule dispatcher in a later phase) is responsible for:
//   - Deriving `runId` via `runIdFor` from the inbound event
//   - Hydrating `ctx.bindings` from `store.loadBindings(runId)` BEFORE
//     calling evaluateProcess (so non-durable steps that reference durable
//     outputs from a prior partial run still see the right values)
//
// The evaluator itself is stateless w.r.t. the store — it pulls the per-run
// checkpoint set once at entry, then walks the steps. No incremental queries.
// ---------------------------------------------------------------------------

export interface CheckpointOptions {
  store: CheckpointStore;
  runId: string;
}

/**
 * Memoization wiring (DURABLE.3). `cache` is the shared two-tier MemoCache;
 * `ttlForFn` is an optional per-primitive TTL resolver — when omitted, all
 * memoizable primitives use the cache's no-TTL behavior (entry lives until
 * evicted by LRU or explicit `clear()`).
 *
 * Default TTLs (when callers wire a resolver):
 *   - llm_classify         → 1h
 *   - recall, embed        → 5m
 *   - http_request         → 30s
 *   - check_destination    → 1h
 */
export interface MemoOptions {
  cache: MemoCache;
  ttlForFn?: (fn: string) => number | undefined;
}

interface EvaluateOptions {
  checkpoint?: CheckpointOptions;
  memo?: MemoOptions;
}

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
  options: EvaluateOptions = {},
): Promise<RuleResult> {
  const { checkpoint, memo } = options;

  // Prefetch the run's checkpoint rows ONCE — keyed by stepIdx so each
  // step does a Map lookup, not a libsql query. Empty map when checkpoint
  // is disabled or the run has no prior history (fresh run / new run_id).
  const prior: Map<number, CheckpointRow> = checkpoint
    ? await loadCheckpointMap(checkpoint.store, checkpoint.runId)
    : new Map<number, CheckpointRow>();

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step) continue; // noUncheckedIndexedAccess guard

    // 1. Conditional skip
    if (step.if !== undefined && !evalCondition(step.if, ctx.bindings)) {
      continue;
    }

    // 2. Interpolate `{{var}}` in string args
    const interpolatedArgs = interpolateArgs(step.args ?? {}, ctx.bindings);

    // 3. Dispatch — wrapped with the durable-checkpoint layer when the
    //    primitive declares `durable: true` AND the caller passed a
    //    checkpoint store. Non-durable primitives flow straight through.
    //    Memoization rides INSIDE the durable wrap and only fires when the
    //    primitive ALSO declares `memoizable: true` (DURABLE.3).
    const meta = registry.durability(step.call);
    const isDurable = checkpoint !== undefined && meta?.durable === true;
    const isMemoizable = memo !== undefined && meta?.memoizable === true;

    let result;
    if (isDurable) {
      result = await invokeDurable(
        i,
        step,
        interpolatedArgs,
        ctx,
        registry,
        checkpoint,
        prior.get(i),
        isMemoizable ? memo : undefined,
      );
    } else if (isMemoizable) {
      // Memoizable but not durable: rare combo (e.g. a cheap pure helper).
      // Allowed by the registry but flagged in docs — the cache works,
      // there's just no checkpoint side-effect.
      result = await invokeMemoized(step, interpolatedArgs, ctx, registry, memo);
    } else {
      result = await registry.call(step.call, interpolatedArgs, ctx);
    }

    // 4. Primitive failed.
    if (!result.ok) {
      // `on_error: 'continue'` is the failure-side twin of `on_empty` (steps
      // 6-8): it lets a rule OBSERVE a step error and branch on it instead of
      // having the runtime swallow the whole process. The error message binds
      // to `step.as` (when set) so the next step's `if:` can test it. Absent or
      // 'abort' (the default) preserves the historical hard-abort with the
      // failing step index for diagnostics.
      if (step.on_error === 'continue') {
        if (step.as !== undefined) ctx.bindings.set(step.as, result.error.message);
        continue;
      }
      return { kind: 'error', error: result.error.message, step: i };
    }

    // 5. `verdict` primitive returns a Verdict shape → terminal.
    // T-ASC ASC.3: route by `level`. Directive verdicts produce a
    // `kind: 'directive'` RuleResult that the dispatcher aggregates
    // alongside contextInjections; every other level produces the
    // historical `kind: 'verdict'` flow into drift_response. The
    // RuleResult's `verdict` field is typed `MessageVerdict` so
    // drift_response.ts's handlers can read `.message` without a guard.
    if (step.call === 'verdict' && isVerdict(result.value)) {
      if (result.value.level === 'directive') {
        return {
          kind: 'directive',
          directive: { next_action: result.value.next_action },
        };
      }
      return { kind: 'verdict', verdict: result.value };
    }

    // 5b. `inject_context` shape → terminal RuleResult variant (G.4).
    //
    // Any primitive that returns `{ kind: 'inject_context', content: string }`
    // short-circuits the rule with that payload (mirroring the `verdict`
    // pattern). `recall_pre_inject` is the production producer; the shape-
    // based check rather than a name-based check keeps the door open for
    // additional context-providing primitives without re-touching the
    // evaluator. Primitives that DON'T want to terminate the rule return a
    // bound value via `as:` instead.
    if (isInjectContext(result.value)) {
      return { kind: 'inject_context', content: result.value.content };
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
// invokeDurable — checkpoint-wrapped primitive call (DURABLE.2).
//
// Reads `prior` (the pre-fetched checkpoint row for this step idx, if any).
// On hit + matching `inputsHash` + `status === 'completed'`, the primitive
// is SKIPPED and the row's `outputs` is returned as the step's value (the
// caller then re-applies the `step.as` binding via the main loop). On miss
// or hash mismatch, the primitive runs and a new checkpoint row is appended.
//
// Hash mismatch policy: re-execute as if there were no prior row. This
// covers the "pack was edited between runs" case — the prior row's outputs
// are no longer trustworthy for current inputs. The new row overwrites via
// `INSERT OR REPLACE`.
//
// Errored primitive: append a row with `status: 'errored'` so DURABLE.4's
// resumer can retry. The evaluator still returns the err to the caller.
//
// `checkpoint.store.append` throws on libsql failure (DURABLE.1 fail-mode);
// the evaluator does NOT swallow the throw — a checkpoint that didn't make
// it to disk is worse than a loud error, because the run would silently
// drop step bindings on the next resume.
// ---------------------------------------------------------------------------

async function invokeDurable(
  stepIdx: number,
  step: ProcessStep,
  interpolatedArgs: Record<string, unknown>,
  ctx: EvalCtx,
  registry: FunctionRegistry,
  checkpoint: CheckpointOptions,
  prior: CheckpointRow | undefined,
  memo: MemoOptions | undefined,
): Promise<Awaited<ReturnType<FunctionRegistry['call']>>> {
  const inputsHash = sha256Hex(canonicalJsonStringify({ fn: step.call, args: interpolatedArgs }));

  // Checkpoint HIT — completed row for same step + same inputs. Skip the
  // primitive call, restore the bound value, and return it as an ok result.
  if (prior?.status === 'completed' && prior.inputsHash === inputsHash) {
    return { ok: true, value: prior.outputs };
  }

  // Memo HIT (DURABLE.3) — when the primitive is memoizable AND we have a
  // cache, look up by (fn, inputsHash). On hit we still write a checkpoint
  // row so that a RESUME of this exact run+step short-circuits at the
  // checkpoint level (skipping even the memo lookup) and so DURABLE.4's
  // resumer sees this step as completed.
  if (memo !== undefined) {
    const hit = await memo.cache.get(step.call, inputsHash, memo.ttlForFn?.(step.call));
    if (hit !== null) {
      const cachedAtMs = Date.now();
      const write = {
        runId: checkpoint.runId,
        stepIdx,
        fn: step.call,
        inputsHash,
        outputs: hit.value,
        startedAtMs: cachedAtMs,
        completedAtMs: cachedAtMs,
        status: 'completed' as const,
        ...(step.as !== undefined ? { asBinding: step.as } : {}),
      };
      await checkpoint.store.append(write);
      return { ok: true, value: hit.value };
    }
  }

  // Checkpoint MISS (no row, hash mismatch, or errored row) — execute fresh.
  // Memoizable primitives funnel the PRIMITIVE INVOCATION through
  // singleflight so 100 concurrent missers on the same (fn, hash) key produce
  // exactly ONE primitive call. The checkpoint write happens AFTER
  // singleflight resolves — it must run once per caller because each caller
  // has a different runId; coupling the write to the singleflight body would
  // leave 99 out of 100 racers without a checkpoint row.
  const startedAtMs = Date.now();
  const result = await invokePrimitive(
    step.call,
    inputsHash,
    () => registry.call(step.call, interpolatedArgs, ctx),
    memo,
  );
  const completedAtMs = Date.now();

  // Persist the outcome BEFORE returning. Throw propagates if the store
  // fails — see header rationale (silent fail-open would lose bindings).
  if (result.ok) {
    const write = {
      runId: checkpoint.runId,
      stepIdx,
      fn: step.call,
      inputsHash,
      outputs: result.value,
      startedAtMs,
      completedAtMs,
      status: 'completed' as const,
      ...(step.as !== undefined ? { asBinding: step.as } : {}),
    };
    await checkpoint.store.append(write);
  } else {
    const write = {
      runId: checkpoint.runId,
      stepIdx,
      fn: step.call,
      inputsHash,
      outputs: null,
      startedAtMs,
      completedAtMs,
      status: 'errored' as const,
      errorMessage: result.error.message,
      ...(step.as !== undefined ? { asBinding: step.as } : {}),
    };
    await checkpoint.store.append(write);
  }
  return result;
}

/**
 * Invoke the primitive once, deduplicated by `(fn, inputsHash)` when a memo
 * cache is wired. The singleflight body ALSO populates the memo cache on
 * success — that way the leader caller and any followers see the same
 * cached value the next time the key is queried. Errored results bypass
 * the memo `set` so the next call retries (spec's retry-not-skip rule).
 *
 * Returns the primitive's Result<T, FunctionError> unchanged. The caller
 * (`invokeDurable` / `invokeMemoized`) handles the checkpoint + binding
 * side effects.
 */
async function invokePrimitive(
  fn: string,
  inputsHash: string,
  call: () => Promise<Awaited<ReturnType<FunctionRegistry['call']>>>,
  memo: MemoOptions | undefined,
): Promise<Awaited<ReturnType<FunctionRegistry['call']>>> {
  if (memo === undefined) {
    return call();
  }
  return memo.cache.singleflight(fn, inputsHash, async () => {
    const result = await call();
    if (result.ok) {
      await memo.cache.set(fn, inputsHash, result.value, memo.ttlForFn?.(fn));
    }
    return result;
  });
}

// ---------------------------------------------------------------------------
// invokeMemoized — memoization without checkpoint side-effects.
//
// Used when a primitive is `memoizable: true` but `durable: false` (or the
// caller didn't pass a checkpoint store). The cache still serves identical
// (fn, args) calls; nothing gets persisted in the checkpoint table.
// Singleflight still protects against stampede.
// ---------------------------------------------------------------------------

async function invokeMemoized(
  step: ProcessStep,
  interpolatedArgs: Record<string, unknown>,
  ctx: EvalCtx,
  registry: FunctionRegistry,
  memo: MemoOptions,
): Promise<Awaited<ReturnType<FunctionRegistry['call']>>> {
  const inputsHash = sha256Hex(canonicalJsonStringify({ fn: step.call, args: interpolatedArgs }));
  const ttlMs = memo.ttlForFn?.(step.call);

  const hit = await memo.cache.get(step.call, inputsHash, ttlMs);
  if (hit !== null) {
    return { ok: true, value: hit.value };
  }

  return invokePrimitive(
    step.call,
    inputsHash,
    () => registry.call(step.call, interpolatedArgs, ctx),
    memo,
  );
}

// ---------------------------------------------------------------------------
// loadCheckpointMap — single-query prefetch of every row for a runId.
//
// Calls `CheckpointStore.fetchRun(runId)` (one libsql SELECT) and keys the
// result by `stepIdx`. The evaluator then dispatches each durable step
// against the pre-fetched map without per-step queries — the only DB hit
// during a process walk is one read at entry plus N writes for the N
// durable steps. Non-durable steps add ZERO database I/O.
//
// Both completed and errored rows land in the map. The wrap (`invokeDurable`)
// checks `status === 'completed'` + `inputsHash` match before honoring the
// hit; errored rows fall through to re-execution.
// ---------------------------------------------------------------------------

async function loadCheckpointMap(
  store: CheckpointStore,
  runId: string,
): Promise<Map<number, CheckpointRow>> {
  const rows = await store.fetchRun(runId);
  const out = new Map<number, CheckpointRow>();
  for (const row of rows) out.set(row.stepIdx, row);
  return out;
}

// ---------------------------------------------------------------------------
// `if:` expression dispatch — H.1.6 cutover.
//
// The old 5-regex evaluator + the numeric-path helper were deleted in H.1.6
// in favor of the chevrotain grammar in `runtime/evaluator/expression/`.
// That module's `evalCondition(expr, bindings)` is imported at the top of
// this file and called directly from the step-loop guard above (search for
// the `step.if` check). The behavior contract per pre-research §12:
//
//   - §12.2: empty/whitespace-only `if:` returns `true` (was silent false +
//     warn). Symmetric with the absent-field case at the loop guard.
//   - §12.3: comparisons are strict — `1 == "1"` is `false`.
//   - §12.4: `phases != "complete"` is valid grammar; the previously-dead
//     `phase-logged-before-commit` rule starts firing for real.
//
// Audit grep: this file contains zero matches for `eval(` or `new Function`,
// and zero matches for the deleted regex-constant names.
// ---------------------------------------------------------------------------

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

// `{{name}}` or `{{name.field.sub}}` — a binding name optionally followed by a
// dotted path into the bound value. The dotted form lets a rule pass a nested
// field (e.g. `{{targs.file_path}}`) into a primitive arg; the single-segment
// form is unchanged (resolves to the binding itself).
const TEMPLATE_DETECT = /\{\{\s*[\w.]+\s*\}\}/;
const TEMPLATE_REPLACE = /\{\{\s*([\w.]+)\s*\}\}/g;

/**
 * Resolve a `head.field.sub` path against the bindings: the first segment is
 * the binding key; each subsequent segment indexes into the (object) value.
 * Returns undefined if any segment is missing or a non-object is traversed —
 * so an unresolved path stringifies to '' exactly like an unbound `{{name}}`.
 */
function resolveBindingPath(path: string, bindings: Map<string, unknown>): unknown {
  const segments = path.split('.');
  let cur: unknown = bindings.get(segments[0]!);
  for (let i = 1; i < segments.length; i++) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[segments[i]!];
  }
  return cur;
}

/**
 * Interpolate `{{name}}` / `{{name.field}}` templates in a value, RECURSING
 * into nested objects + arrays so a template inside a structured arg (e.g. a
 * verdict's `next_action.args.pre_research_path`) resolves too. String leaves
 * are substituted; non-strings pass through unchanged.
 */
function interpolateValue(v: unknown, bindings: Map<string, unknown>): unknown {
  if (typeof v === 'string') {
    return TEMPLATE_DETECT.test(v)
      ? v.replace(TEMPLATE_REPLACE, (_match, name: string) =>
          stringifyBinding(resolveBindingPath(name, bindings)),
        )
      : v;
  }
  if (Array.isArray(v)) return v.map((x) => interpolateValue(x, bindings));
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = interpolateValue(val, bindings);
    return out;
  }
  return v;
}

function interpolateArgs(
  args: Record<string, unknown>,
  bindings: Map<string, unknown>,
): Record<string, unknown> {
  return interpolateValue(args, bindings) as Record<string, unknown>;
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
  if (!('level' in v) || typeof v.level !== 'string') return false;
  // T-ASC ASC.3: 5 levels now. The 4 message-bearing levels require
  // `message: string`; the `directive` level requires
  // `next_action: object` instead.
  if (v.level === 'directive') {
    return 'next_action' in v && typeof v.next_action === 'object' && v.next_action !== null;
  }
  return 'message' in v && typeof v.message === 'string';
}

// ---------------------------------------------------------------------------
// isInjectContext — TS type predicate for the G.4 inject_context shape.
//
// The `recall_pre_inject` primitive (and any future context-providing
// primitive) returns `{ kind: 'inject_context', content: string }` to
// short-circuit the rule with a payload the hook layer will inject into
// the host's prompt context. Shape-based check (not name-based) so the
// evaluator stays open to multiple producers without re-touching this file.
// ---------------------------------------------------------------------------

function isInjectContext(v: unknown): v is { kind: 'inject_context'; content: string } {
  if (typeof v !== 'object' || v === null) return false;
  if (!('kind' in v) || !('content' in v)) return false;
  return v.kind === 'inject_context' && typeof v.content === 'string';
}
