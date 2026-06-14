/**
 * Function-library registry: typed `FunctionDef` + name-keyed dispatcher.
 *
 * Architecture (per `project_opensquid_modular_function_skill_separation`):
 * the runtime ships atomic primitives (regex, state I/O, LLM calls, verdicts);
 * skills compose them into rule processes via YAML. The registry is the ONLY
 * path from a skill step to a primitive — no global `import { add }`
 * shortcuts. The evaluator (Task 1.3) drives every call through `call()`.
 *
 * Each `FunctionDef` carries its own Zod arg schema. The registry validates
 * args before invoking `execute`, so primitives see only well-typed input
 * and never have to re-check what the YAML claimed it was passing.
 *
 * Error model: throws are reserved for programmer errors at startup
 * (duplicate registration). Runtime failures travel as `Result<T, FunctionError>`
 * — see `src/runtime/result.ts`. Primitives MUST NOT throw inside `execute`;
 * the evaluator catches stray throws and wraps them in `{ kind: 'runtime' }`,
 * but that path is for bugs, not for normal failure modes.
 *
 * Imports from: zod, runtime/types.ts, runtime/result.ts.
 * Imported by: runtime/ (evaluator), packs/ (when skills resolve `function:` refs).
 */

import type { z } from 'zod';

import type { ModelsConfig } from '../packs/schemas/models.js';
import { type Result, err } from '../runtime/result.js';
import type { Event } from '../runtime/types.js';
import type { Fsm } from '../runtime/fsm.js';

// ---------------------------------------------------------------------------
// EvalCtx — the per-call context handed to every primitive
//
// `bindings` is the rule's local variable scope (output of prior process
// steps). Primitives that capture this Map by reference can mutate the
// caller's state — audit rule: primitives only mutate via documented side
// effects (state I/O), not via bindings.
// ---------------------------------------------------------------------------

export interface EvalCtx {
  event: Event;
  bindings: Map<string, unknown>;
  sessionId: string;
  packId: string;
  /**
   * PR-followup: pack-shipped `models.yaml` content (`Pack.models`), threaded
   * through so `llm_classify` / `subagent_call` primitives can consult the
   * pack's declared aliases without the global `loadModelsConfig()` call
   * having to re-discover the active pack. `undefined` for packs that ship
   * no `models.yaml` and for non-pack call sites (legacy daemon).
   */
  packModels?: ModelsConfig;
  /**
   * Slice A3b: the calling pack's declared lifecycle FSM (`Pack.fsm`), threaded
   * like `packModels` so `read_fsm_state` / `advance_fsm` can read + advance the
   * machine without re-loading the pack. `undefined` when the pack ships no
   * `fsm.yaml` (those primitives then no-op).
   */
  packFsm?: Fsm;
  /**
   * wg-7f6225238a27: the calling pack's operating procedure (`Pack.procedure`, from
   * `procedure.md`), threaded like `packModels`/`packFsm` so `procedure_pre_inject` reads it
   * without re-loading the pack. `undefined` when the pack ships no `procedure.md`.
   */
  packProcedure?: string;
}

// ---------------------------------------------------------------------------
// FunctionError — recoverable failures returned by `call()`
//
//   arg_invalid — Zod rejected the args (cause = ZodError)
//   not_found   — no primitive registered under that name
//   runtime     — primitive returned an `Err` with kind 'runtime', OR the
//                 evaluator wrapped a stray throw (the latter is a bug)
//   timeout     — reserved for primitives that enforce a deadline
// ---------------------------------------------------------------------------

export interface FunctionError {
  kind: 'arg_invalid' | 'runtime' | 'timeout' | 'not_found';
  message: string;
  cause?: unknown;
}

// ---------------------------------------------------------------------------
// FunctionDef — the contract a primitive implements
//
// Generic over TArgs / TResult so the call site sees the right types, but
// type-erased to `FunctionDef<unknown, unknown>` once inside the registry
// Map (see `register` for the existential cast).
//
// DURABLE.2 fields (`durable`, `memoizable`, `costEstimateMs`):
//
//   `durable`         — when `true`, the evaluator (DURABLE.2 wrap) appends a
//                       checkpoint row after every invocation so a crashed
//                       process can resume mid-rule. When `false`, the
//                       evaluator skips the checkpoint write entirely
//                       (cheap primitives re-run faster than the cost of
//                       persisting them).
//
//   `memoizable`      — when `true`, identical `(fn, args)` calls within a
//                       run can be served from the memo cache (DURABLE.3 —
//                       LIVE: evaluator.ts invokeMemoized; the key EXCLUDES
//                       ctx, so memoizable primitives must be TRANSITIVELY
//                       ctx-pure — see memo_purity.test.ts, FAC.1).
//                       `memoizable: true, durable: false`
//                       is allowed but unusual — the cache persists only
//                       for the lifetime of the in-memory tier (LRU); it
//                       does not survive daemon restart on its own.
//                       Document it in the primitive header when used.
//
//   `costEstimateMs?` — hint for benchmarking + future tier routing
//                       (DURABLE.4 uses it to pick which interrupted runs to
//                       resume first). Order-of-magnitude only; the value
//                       does not gate any runtime decision in DURABLE.2.
//
// Default policy: if a primitive registers WITHOUT these fields, the
// registry treats them as `false` and emits a single console.warn naming
// the primitive (audit rule: every primitive must declare explicitly).
// ---------------------------------------------------------------------------

export interface FunctionDef<TArgs = unknown, TResult = unknown> {
  name: string;
  argSchema: z.ZodSchema<TArgs>;
  execute: (args: TArgs, ctx: EvalCtx) => Promise<Result<TResult, FunctionError>>;
  /** Checkpoint after each call so crashes can resume mid-rule. */
  durable?: boolean;
  /** Cache identical `(fn, args)` outputs (DURABLE.3, wired separately). */
  memoizable?: boolean;
  /** Order-of-magnitude latency hint; informational only. */
  costEstimateMs?: number;
}

// ---------------------------------------------------------------------------
// FunctionRegistry — name → FunctionDef dispatcher
//
// All public methods are sync except `call`, which awaits the primitive.
// `register` throws on duplicate name because that is a startup-time
// programmer error (two packs collide on a name; the user must rename one).
// Every other failure mode is a Result.
// ---------------------------------------------------------------------------

/**
 * Effective (post-default) durability metadata for a registered primitive.
 * Returned by `FunctionRegistry.durability` so callers (evaluator, future
 * memo cache, audit tooling) read a normalized record rather than poking at
 * the raw `FunctionDef`.
 */
export interface PrimitiveDurability {
  durable: boolean;
  memoizable: boolean;
  costEstimateMs: number | undefined;
}

export class FunctionRegistry {
  private map = new Map<string, FunctionDef<unknown, unknown>>();

  register<TArgs, TResult>(def: FunctionDef<TArgs, TResult>): void {
    if (this.map.has(def.name)) {
      throw new Error(`Function "${def.name}" already registered`);
    }
    // DURABLE.2 — warn loudly when a primitive omits the durability flag.
    // Default is `false` (cheap fail-safe), but silent default-false on a
    // primitive that SHOULD be durable would double-charge on every resume
    // (e.g. an llm_classify variant whose author forgot the flag). The
    // warning surfaces the omission at registration time so audit catches
    // it before it ships. `memoizable` is bundled into the same warning —
    // either both flags are explicit or neither is, by author convention.
    if (def.durable === undefined) {
      console.warn(
        `[opensquid:registry] Primitive "${def.name}" registered without an ` +
          `explicit \`durable\` flag — defaulting to \`false\`. Declare ` +
          `\`durable: true | false\` on the FunctionDef to silence this warning.`,
      );
    }
    // type-erasure cast: TArgs/TResult are existentially quantified in the
    // registry's Map. Each entry knows its own schema at the value level
    // (via def.argSchema), so we don't need TS to track them per entry.
    this.map.set(def.name, def as FunctionDef<unknown, unknown>);
  }

  get(name: string): FunctionDef<unknown, unknown> | undefined {
    return this.map.get(name);
  }

  has(name: string): boolean {
    return this.map.has(name);
  }

  list(): string[] {
    return [...this.map.keys()].sort();
  }

  /**
   * Normalized durability metadata for a registered primitive. Returns
   * `undefined` if the name is not registered. Default-falses apply so
   * downstream code never has to repeat the `?? false` plumbing.
   */
  durability(name: string): PrimitiveDurability | undefined {
    const def = this.map.get(name);
    if (!def) return undefined;
    return {
      durable: def.durable ?? false,
      memoizable: def.memoizable ?? false,
      costEstimateMs: def.costEstimateMs,
    };
  }

  async call(
    name: string,
    rawArgs: unknown,
    ctx: EvalCtx,
  ): Promise<Result<unknown, FunctionError>> {
    const def = this.map.get(name);
    if (!def) {
      return err<FunctionError>({
        kind: 'not_found',
        message: `No function "${name}"`,
      });
    }
    const parsed = def.argSchema.safeParse(rawArgs);
    if (!parsed.success) {
      return err<FunctionError>({
        kind: 'arg_invalid',
        message: `Invalid args for "${name}": ${parsed.error.message}`,
        cause: parsed.error,
      });
    }
    return def.execute(parsed.data, ctx);
  }
}
