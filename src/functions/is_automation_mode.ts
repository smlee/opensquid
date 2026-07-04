/**
 * `is_automation_mode` primitive — gate skill rules on whether the session
 * is currently in an automation loop (G.12).
 *
 * ONE signal source (env-only):
 *
 *   `OPENSQUID_AUTOMATION=1` env var — the orchestrator sets this on its driven
 *   subprocess; a user (or wrapper script) can also set it explicitly. This is
 *   the SAME signal the FSM-gate path checks (`pre-tool-use.ts` v2 automation
 *   gate, `process.env.OPENSQUID_AUTOMATION === '1'`), so the skill path and the
 *   gate path agree.
 *
 * ENV-ONLY (the per-session `automation.flag` file OR was retired): a stale flag
 * left by a prior automation lap would bleed into an interactive session sharing
 * the same session id and block legitimate human tool calls (Hole 2). The
 * `opensquid automation on|off` CLI still writes/reads the flag for its own
 * status verb, but this predicate no longer consults it.
 *
 * Return shape: `ok({ value: boolean, source: 'env' | 'none' })`. The `source`
 * field is purely for downstream observability — skills branch on `value`.
 *
 * Failure model: this primitive cannot fail — the env read is sync + cheap. We
 * register `durable: false, memoizable: false` because the answer can flip
 * mid-run (the env var differs per subprocess) and caching would defeat the gate.
 *
 * Imports from: zod, ../runtime/result.js, ./registry.js.
 * Imported by: src/runtime/bootstrap.ts (registry wiring).
 */

import { z } from 'zod';

import { ok } from '../runtime/result.js';

import type { FunctionDef } from './registry.js';

export const IsAutomationModeArgs = z.object({}).strict();

export type AutomationSource = 'env' | 'none';

export interface IsAutomationModeResult {
  value: boolean;
  source: AutomationSource;
}

export const IsAutomationMode: FunctionDef<
  z.input<typeof IsAutomationModeArgs>,
  IsAutomationModeResult
> = {
  name: 'is_automation_mode',
  argSchema: IsAutomationModeArgs,
  durable: false,
  memoizable: false,
  costEstimateMs: 1,
  execute: async () => {
    if (process.env.OPENSQUID_AUTOMATION === '1') {
      return ok({ value: true, source: 'env' });
    }
    return ok({ value: false, source: 'none' });
  },
};
