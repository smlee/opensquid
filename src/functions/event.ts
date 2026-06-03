/* eslint-disable @typescript-eslint/require-await */
/**
 * Event-inspection primitives: `tool_name`, `tool_args`, `cwd`,
 * `last_assistant_message`, `match_command`.
 *
 * Note on `require-await`: the `FunctionDef.execute` contract is
 * `Promise<Result<...>>`. These five primitives are pure reads off
 * `EvalCtx.event` — no awaitable work to do. We satisfy the contract by
 * declaring the methods `async` (which wraps the return value in a Promise)
 * and disable `@typescript-eslint/require-await` for this file. Future
 * primitives in this file should keep the file-level disable as-is.
 *
 * Per `docs/opensquid-real-design.md` §"Phase 1 — Runtime skeleton" (event
 * inspection primitives). These five primitives are the read-only accessors
 * skills compose to interrogate the current `Event` carried in `EvalCtx`.
 *
 * Wrong-kind discipline: every accessor returns `ok(null)` (or `ok(false)`
 * for `match_command`) when the event kind doesn't match what the accessor
 * expects. NEVER throws, NEVER errs — wrong-kind is a normal control-flow
 * signal that skills branch on, not a failure. The evaluator's stray-throw
 * wrapper is reserved for genuine bugs.
 *
 * `match_command` shallow-path contract: `target` is `tool_args.<field>` and
 * resolves only one level deep. Nested paths (e.g. `tool_args.input.text`)
 * are out of scope for Phase 1 — skills can pre-stage a deeper field via a
 * future accessor primitive. Bad regex returns `err({ kind: 'arg_invalid' })`
 * rather than throwing so the evaluator's per-step error path picks it up
 * cleanly.
 *
 * Imports from: zod, ../runtime/result.js, ./registry.js.
 * Imported by: src/functions/index.ts (registry wiring).
 */

import { z } from 'zod';

import { err, ok } from '../runtime/result.js';

import type { FunctionRegistry } from './registry.js';

// ---------------------------------------------------------------------------
// Zod arg schemas — `.strict()` on EmptyArgs so unexpected keys become
// `arg_invalid` at registry-call time (better than silently ignoring typos
// in YAML). `MatchCommandArgs` keeps `target` optional; default behavior
// reads `tool_args.command`.
// ---------------------------------------------------------------------------

const EmptyArgs = z.object({}).strict();
const MatchCommandArgs = z.object({
  pattern: z.string(),
  target: z.string().optional(),
});

// ---------------------------------------------------------------------------
// resolveCommandField — shallow `tool_args.<field>` lookup for match_command.
//
// `target` undefined or exactly `tool_args.command` → read `args.command`.
// Anything else with a `tool_args.` prefix → read `args[<rest>]`. Missing
// field or non-string value → empty string (regex tests against `''`, which
// for any non-trivial pattern is `false` — matches the "no command, no
// match" intuition).
// ---------------------------------------------------------------------------

function resolveCommandField(args: Record<string, unknown>, target: string | undefined): string {
  const field =
    target === undefined || target === 'tool_args.command'
      ? 'command'
      : target.replace(/^tool_args\./, '');
  const value = args[field];
  return typeof value === 'string' ? value : '';
}

export function registerEventFunctions(registry: FunctionRegistry): void {
  // DURABLE.2 — every primitive in this file is a pure read off `EvalCtx.event`
  // (no I/O, no LLM call). Cost is sub-microsecond; checkpoint overhead would
  // exceed re-run cost by orders of magnitude. `match_command` runs one regex
  // — still cheap; `costEstimateMs: 0.1` is the order-of-magnitude marker the
  // benchmarks use to group "trivial" primitives.
  registry.register({
    name: 'tool_name',
    argSchema: EmptyArgs,
    durable: false,
    memoizable: false,
    costEstimateMs: 0.1,
    execute: async (_args, ctx) => {
      // Both tool_call (PreToolUse) and post_tool_call (PostToolUse) carry the
      // tool name; a rule on either event can read it. Any other event → null.
      if (ctx.event.kind === 'tool_call' || ctx.event.kind === 'post_tool_call') {
        return ok(ctx.event.tool);
      }
      return ok(null);
    },
  });

  registry.register({
    name: 'tool_args',
    argSchema: EmptyArgs,
    durable: false,
    memoizable: false,
    costEstimateMs: 0.1,
    execute: async (_args, ctx) => {
      if (ctx.event.kind !== 'tool_call') return ok(null);
      return ok(ctx.event.args);
    },
  });

  registry.register({
    name: 'cwd',
    argSchema: EmptyArgs,
    durable: false,
    memoizable: false,
    costEstimateMs: 0.1,
    execute: async (_args, ctx) => {
      if (ctx.event.kind !== 'tool_call') return ok(null);
      return ok(ctx.event.cwd ?? null);
    },
  });

  registry.register({
    name: 'last_assistant_message',
    argSchema: EmptyArgs,
    durable: false,
    memoizable: false,
    costEstimateMs: 0.1,
    execute: async (_args, ctx) => {
      // RJ.1: the prior assistant turn is available at BOTH stop (current
      // turn, but off-by-one-prone) and prompt_submit (the SETTLED prior turn,
      // filled by the UPS hook from the transcript — no off-by-one). Every
      // other event kind has no assistant text → null.
      if (ctx.event.kind === 'stop') return ok(ctx.event.assistantText);
      if (ctx.event.kind === 'prompt_submit') return ok(ctx.event.priorAssistantText ?? null);
      return ok(null);
    },
  });

  registry.register({
    name: 'recent_turns',
    argSchema: EmptyArgs,
    durable: false,
    memoizable: false,
    costEstimateMs: 0.1,
    execute: async (_args, ctx) => {
      // FU.2: the last N conversation turns (role-labeled), filled by the UPS
      // hook from the transcript. Only present on prompt_submit; null elsewhere.
      if (ctx.event.kind === 'prompt_submit') return ok(ctx.event.recentTurns ?? null);
      return ok(null);
    },
  });

  registry.register({
    name: 'match_command',
    argSchema: MatchCommandArgs,
    durable: false,
    memoizable: false,
    costEstimateMs: 0.1,
    execute: async ({ pattern, target }, ctx) => {
      if (ctx.event.kind !== 'tool_call') return ok(false);
      const command = resolveCommandField(ctx.event.args, target);
      let regex: RegExp;
      try {
        regex = new RegExp(pattern);
      } catch (e: unknown) {
        return err({
          kind: 'arg_invalid',
          message: `Bad regex for match_command: ${pattern}`,
          cause: e,
        });
      }
      return ok(regex.test(command));
    },
  });
}
