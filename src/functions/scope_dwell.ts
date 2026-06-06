/**
 * scope_dwell_tick (T-FLOW-UNSKIPPABLE FU.2 / D2) — scope-sprawl escalation.
 *
 * Closes the last flow-gate gap: the SCOPE phase is otherwise ungated, so a
 * sprawling, oscillating scope (many prompts of investigation, no pre-research
 * converging) is invisible — the failure mode of this very session. On each
 * `prompt_submit` while the coding-flow FSM is in `scoping`/`researching`, this
 * increments a per-session dwell counter; once it reaches the threshold (3 — the
 * same `depth.count >= 3` "one full research turn" bar the scope-advance uses)
 * with the scope still un-converged, it returns `nudge: true` so the rule surfaces
 * a "converge: write ONE pre-research now" directive. It RESETS the moment the FSM
 * leaves the scope region (a pre-research write advances `scoping → researched`),
 * so an honest converging scope sees the nudge at most once.
 *
 * SOFT by design: the rule emits a `directive` (surface), never a block — research
 * legitimately needs multiple turns; this nudges convergence, it does not forbid
 * investigation. Fail-open: any error → `{ nudge: false }` (a nudge must never
 * break a prompt).
 *
 * Imports from: node:fs/promises, zod, ../runtime/result.js, ../runtime/paths.js,
 *   ../runtime/fsm_state.js.
 * Imported by: src/runtime/bootstrap.ts (registry wiring).
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { z } from 'zod';

import { readFsmStateRaw } from '../runtime/fsm_state.js';
import { sessionStateFile } from '../runtime/paths.js';
import { ok } from '../runtime/result.js';

import type { FunctionDef } from './registry.js';

const NoArgs = z.object({}).strict();

/** Gate pack whose FSM defines the scope region. */
const GATE_PACK = 'coding-flow';
/** Dwell turns in scope before nudging — matches the scope-advance depth bar. */
const DWELL_THRESHOLD = 3;
const DWELL_KEY = 'coding-flow-scope-dwell';

interface DwellResult {
  nudge: boolean;
  count: number;
}

export const ScopeDwellTick: FunctionDef<z.input<typeof NoArgs>, DwellResult> = {
  name: 'scope_dwell_tick',
  argSchema: NoArgs,
  durable: false,
  memoizable: false,
  costEstimateMs: 3,
  execute: async (_args, ctx) => {
    const path = sessionStateFile(ctx.sessionId, DWELL_KEY);
    const write = async (n: number): Promise<void> => {
      try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, JSON.stringify(n), 'utf8');
      } catch {
        /* best-effort */
      }
    };
    try {
      const st = await readFsmStateRaw(ctx.sessionId, GATE_PACK);
      const inScope = st === 'scoping' || st === 'researching';
      if (!inScope) {
        await write(0); // left the scope region (e.g. a pre-research advanced it) → reset
        return ok({ nudge: false, count: 0 });
      }
      let cur = 0;
      try {
        cur = Number(JSON.parse(await readFile(path, 'utf8')) as unknown) || 0;
      } catch {
        cur = 0;
      }
      const next = cur + 1;
      await write(next);
      return ok({ nudge: next >= DWELL_THRESHOLD, count: next });
    } catch {
      return ok({ nudge: false, count: 0 });
    }
  },
};
