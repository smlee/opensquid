/**
 * `reset_scope_track_state` primitive — clear the per-track scope state as a UNIT when a
 * new track begins (the `scope_start` re-arm). Without it, a shipped track's
 * pre-research/spec/design pointers leak into the next track: the handover renderer re-fires
 * the finished track's artifacts, and the AUTHOR coverage audit reads the stale design
 * (wg-4c48ef1b9969).
 *
 * The cleared set is `SCOPE_TRACK_STATE_KEYS` (one home — adding a future per-track key there
 * keeps the renderer's read and this reset in sync). Writes JSON `null` so `read_state` returns
 * `null` directly. Best-effort: a clear failure must NEVER abort the re-arm rule (the rule orders
 * this AFTER `advance_fsm`), so every write is individually try/caught and the primitive always
 * resolves `ok(null)`.
 *
 * Imports from: zod, ../runtime/result.js, ../runtime/coding_flow_keys.js,
 *   ../runtime/paths.js, ../runtime/atomic_write.js, ./registry.js.
 * Imported by: src/functions/index.ts (registry wiring via bootstrap).
 */

import { z } from 'zod';

import { atomicWriteFile } from '../runtime/atomic_write.js';
import { SCOPE_TRACK_STATE_KEYS } from '../runtime/coding_flow_keys.js';
import { sessionStateFile } from '../runtime/paths.js';
import { ok } from '../runtime/result.js';

import type { FunctionRegistry } from './registry.js';

const EmptyArgs = z.object({}).strict();

export function registerResetScopeTrackStateFunction(registry: FunctionRegistry): void {
  registry.register({
    name: 'reset_scope_track_state',
    argSchema: EmptyArgs,
    durable: false,
    memoizable: false,
    costEstimateMs: 5,
    execute: async (_args, ctx) => {
      for (const key of SCOPE_TRACK_STATE_KEYS) {
        try {
          await atomicWriteFile(sessionStateFile(ctx.sessionId, key), JSON.stringify(null));
        } catch {
          /* best-effort: a clear failure must never block the scope_start arm */
        }
      }
      return ok(null);
    },
  });
}
