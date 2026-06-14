/**
 * `set_request_type` primitive (RTC.5, wg-3d175ec06767).
 *
 * Overwrites the persisted request-type record's `type` (preserving `prompt_hash`/`at`), marking it
 * `source:'llm', confidence:'high'`. Used by the refinement rule: when the deterministic classifier
 * was uncertain (`confidence:'low'`), a fast `llm_classify` decides research-vs-work and this writes
 * the refined verdict. A plain string arg avoids YAML object-templating. No-op when no record exists.
 */

import { z } from 'zod';

import { ok } from '../runtime/result.js';
import { readRequestType, writeRequestType } from '../runtime/session_state.js';

import type { FunctionRegistry } from './registry.js';

const Args = z.object({ type: z.enum(['research', 'work']) }).strict();

export function registerSetRequestType(registry: FunctionRegistry): void {
  registry.register({
    name: 'set_request_type',
    argSchema: Args,
    durable: false,
    memoizable: false,
    costEstimateMs: 2,
    execute: async ({ type }, ctx) => {
      const cur = await readRequestType(ctx.sessionId);
      if (cur === null) return ok(null); // nothing to refine
      await writeRequestType(ctx.sessionId, {
        ...cur,
        type,
        source: 'llm',
        confidence: 'high',
      });
      return ok(null);
    },
  });
}
