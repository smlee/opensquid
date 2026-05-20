/* eslint-disable @typescript-eslint/require-await */
/**
 * Verdict + action-descriptor primitives.
 *
 * Four primitives, registered as one batch via `registerVerdictFunctions`:
 *
 *   verdict                  — terminal rule output. The evaluator (Task 1.3)
 *                              special-cases `step.call === 'verdict'` and
 *                              treats `ok({ level, message })` as the rule's
 *                              final RuleResult. This primitive is the only
 *                              way a rule produces a `Verdict`.
 *   halt_task                — emits a `{ kind: 'halt', reason }` action
 *                              descriptor. The hook layer (Task 1.7) reads
 *                              the descriptor and actually halts the host
 *                              session — this primitive never side-effects.
 *   restart_workflow         — emits `{ kind: 'restart', entrySkill }`.
 *                              snake-case YAML arg `entry_skill` → camelCase
 *                              field `entrySkill` (opensquid convention).
 *   set_active_task_state    — emits `{ kind: 'state_set', state }`. Does
 *                              NOT write to disk — that requires composing
 *                              `write_state` (Task 1.4) in a separate step.
 *                              Splitting "declare intent" from "do the write"
 *                              keeps the audit trail explicit.
 *
 * `require-await` disable: same rationale as `event.ts`. The
 * `FunctionDef.execute` contract is `Promise<Result<...>>` but these four
 * primitives are pure — no awaitable work. `async` wraps the return value
 * in a Promise to satisfy the contract.
 *
 * Per `docs/opensquid-real-design.md` §"Required runtime primitives".
 * `auto_correct` and `escalate` policies are deferred per Task 1.6 spec —
 * they need primitives that don't ship in Phase 1 (auto-correction loop +
 * escalation routing).
 *
 * Imports from: zod, ../runtime/result.js, ./registry.js.
 * Imported by: src/functions/index.ts (registry wiring).
 */

import { z } from 'zod';

import { ok } from '../runtime/result.js';

import type { FunctionRegistry } from './registry.js';

// ---------------------------------------------------------------------------
// Zod arg schemas — `.strict()` rejects unexpected YAML keys at registry-call
// time so typos surface as `arg_invalid` instead of silently dropping fields.
// `level` mirrors `VerdictLevel` in runtime/types.ts; duplicated here so the
// primitive doesn't depend on importing the schema (keeps the import graph
// shallow and lets the registry validate without runtime-level types).
// ---------------------------------------------------------------------------

const VerdictArgs = z
  .object({
    level: z.enum(['pass', 'block', 'warn', 'surface']),
    message: z.string(),
  })
  .strict();

const HaltTaskArgs = z.object({ reason: z.string() }).strict();
const RestartWorkflowArgs = z.object({ entry_skill: z.string() }).strict();
const SetActiveTaskStateArgs = z.object({ state: z.string() }).strict();

export function registerVerdictFunctions(registry: FunctionRegistry): void {
  // DURABLE.2 — every primitive in this file is a pure object builder (no
  // I/O, no LLM, no shell). Sub-microsecond cost; checkpointing them would
  // be a net loss. None are memoizable because the input → output mapping
  // is so trivial there's nothing to cache that wouldn't be re-computed
  // faster than a cache lookup.
  registry.register({
    name: 'verdict',
    argSchema: VerdictArgs,
    durable: false,
    memoizable: false,
    costEstimateMs: 0.1,
    execute: async ({ level, message }) => ok({ level, message }),
  });

  registry.register({
    name: 'halt_task',
    argSchema: HaltTaskArgs,
    durable: false,
    memoizable: false,
    costEstimateMs: 0.1,
    execute: async ({ reason }) => ok({ kind: 'halt' as const, reason }),
  });

  registry.register({
    name: 'restart_workflow',
    argSchema: RestartWorkflowArgs,
    durable: false,
    memoizable: false,
    costEstimateMs: 0.1,
    execute: async ({ entry_skill }) => ok({ kind: 'restart' as const, entrySkill: entry_skill }),
  });

  registry.register({
    name: 'set_active_task_state',
    argSchema: SetActiveTaskStateArgs,
    durable: false,
    memoizable: false,
    costEstimateMs: 0.1,
    execute: async ({ state }) => ok({ kind: 'state_set' as const, state }),
  });
}
