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

import { type Result, err } from '../runtime/result.js';
import type { Event } from '../runtime/types.js';

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
// ---------------------------------------------------------------------------

export interface FunctionDef<TArgs = unknown, TResult = unknown> {
  name: string;
  argSchema: z.ZodSchema<TArgs>;
  execute: (args: TArgs, ctx: EvalCtx) => Promise<Result<TResult, FunctionError>>;
}

// ---------------------------------------------------------------------------
// FunctionRegistry — name → FunctionDef dispatcher
//
// All public methods are sync except `call`, which awaits the primitive.
// `register` throws on duplicate name because that is a startup-time
// programmer error (two packs collide on a name; the user must rename one).
// Every other failure mode is a Result.
// ---------------------------------------------------------------------------

export class FunctionRegistry {
  private map = new Map<string, FunctionDef<unknown, unknown>>();

  register<TArgs, TResult>(def: FunctionDef<TArgs, TResult>): void {
    if (this.map.has(def.name)) {
      throw new Error(`Function "${def.name}" already registered`);
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
