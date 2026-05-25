/**
 * `is_automation_mode` primitive — gate skill rules on whether the session
 * is currently in an automation loop (G.12).
 *
 * Two signal sources, OR'd at the boundary:
 *
 *   1. `OPENSQUID_AUTOMATION=1` env var — process-level override the user
 *      (or a wrapper script) sets explicitly. Manual escape hatch when the
 *      flag-file path doesn't apply (e.g. ad-hoc dist-binary testing).
 *   2. `~/.opensquid/sessions/<session-id>/automation.flag` — the canonical
 *      signal the `opensquid automation on|off` CLI writes/removes. File
 *      EXISTENCE = automation on; absence = automation off. Source-of-truth
 *      for `/loop` and any future automation-aware skill.
 *
 * Return shape: `ok({ value: boolean, source: 'env' | 'flag' | 'none' })`.
 * The `source` field is purely for downstream observability (audit logs,
 * trace ui) — skills should branch on `value`, never on `source`.
 *
 * Active-loops-registry integration (3rd source from the spec) is
 * INTENTIONALLY OUT OF SCOPE for G.12 — the `/loop` skill doesn't yet ship
 * its own state file. Phase-2 lock #1: ANY of (env|flag) = true.
 *
 * Failure model: this primitive cannot fail in any meaningful way — env
 * read is sync + cheap, flag-file ENOENT is the "off" answer. We register
 * `durable: false, memoizable: false` because the answer can flip mid-run
 * (user toggles `opensquid automation on/off` between turns) and caching
 * would defeat the whole point of the gate.
 *
 * Imports from: node:fs/promises, zod, ../runtime/result.js,
 *   ../runtime/automation_state.js, ./registry.js.
 * Imported by: src/runtime/bootstrap.ts (registry wiring).
 */

import { z } from 'zod';

import { isAutomationFlagSet } from '../runtime/automation_state.js';
import { ok } from '../runtime/result.js';

import type { FunctionDef } from './registry.js';

export const IsAutomationModeArgs = z.object({}).strict();

export type AutomationSource = 'env' | 'flag' | 'none';

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
  execute: async (_args, ctx) => {
    if (process.env.OPENSQUID_AUTOMATION === '1') {
      return ok({ value: true, source: 'env' });
    }
    if (await isAutomationFlagSet(ctx.sessionId)) {
      return ok({ value: true, source: 'flag' });
    }
    return ok({ value: false, source: 'none' });
  },
};
