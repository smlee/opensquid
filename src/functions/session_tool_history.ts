/**
 * `session_tool_history` primitive — reads the per-session tool-call ledger
 * maintained by `src/runtime/session_state.ts`.
 *
 * Returns the list of tool names observed by the `PreToolUse` hook either
 * for the current turn (`scope: 'current_turn'`, reset on every
 * `UserPromptSubmit`) or for the whole session (`scope: 'session'`, capped
 * at `SESSION_LEDGER_CAP = 200` most-recent entries).
 *
 * Used by G.5's `verify-before-citing-memory` skill to verify that a
 * verification tool (`Bash`, `Read`, `Grep`, `mcp__opensquid__recall`,
 * `mcp__opensquid__inspect_skill`) was called this turn BEFORE the
 * assistant cited memory state — a structural anti-drift signal codified
 * from `feedback_verify_code_before_memory`.
 *
 * `filter_names` is an optional allow-list applied AFTER the scope lookup:
 * empty result is the load-bearing signal "no verification this turn",
 * which the skill chains into a `warn` verdict via the `if:` field on the
 * subsequent `verdict` step.
 *
 * Error model: relies on `readSessionToolLedger`, which fail-safes to
 * `{ tools: [] }` on ENOENT / malformed state. Never throws.
 *
 * Imports from: zod, ../runtime/session_state.js, ../runtime/result.js,
 *   ./registry.js.
 * Imported by: src/runtime/bootstrap.ts (registry wiring).
 */

import { z } from 'zod';

import { ok } from '../runtime/result.js';
import { readSessionToolLedger } from '../runtime/session_state.js';

import type { FunctionDef } from './registry.js';

export const SessionToolHistoryArgs = z
  .object({
    scope: z.enum(['current_turn', 'session', 'since_scope_start']).default('current_turn'),
    filter_names: z.array(z.string()).optional(),
  })
  .strict();

interface SessionToolHistoryResult {
  tools: string[];
  count: number;
}

export const SessionToolHistory: FunctionDef<
  z.input<typeof SessionToolHistoryArgs>,
  SessionToolHistoryResult
> = {
  name: 'session_tool_history',
  argSchema: SessionToolHistoryArgs,
  durable: false,
  memoizable: false,
  costEstimateMs: 2,
  execute: async (args, ctx) => {
    const scope = args.scope ?? 'current_turn';
    const ledger = await readSessionToolLedger(ctx.sessionId, scope);
    const tools = args.filter_names
      ? ledger.tools.filter((t) => args.filter_names!.includes(t))
      : ledger.tools;
    return ok({ tools, count: tools.length });
  },
};
