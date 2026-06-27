/**
 * claim_evidence_gate — the tool_call side of the evidence-prerequisite BLOCK.
 *
 * Pairs with `verify-before-claiming` (stop): when the agent makes a load-bearing
 * claim WITHOUT gathering evidence that turn, the stop skill writes a session flag
 * (`unbacked-claim`). This primitive, fired on every tool_call, reads that flag and
 * decides whether to BLOCK the about-to-run tool:
 *
 *   - no flag                         → not blocked (the common path, cheap).
 *   - flag + an EVIDENCE tool (now or already this turn) → CLEAR the flag + allow.
 *     Evidence tools are NEVER blocked, so the agent can always unstick by running
 *     a Read/Grep/Bash/recall — no deadlock.
 *   - flag + a NON-evidence tool + no evidence yet this turn → BLOCKED.
 *
 * Why a primitive (not a YAML `if:`): a rule's `if:` evaluates only against bound
 * vars (`evaluator.ts:173`), so it cannot read `ctx.event.tool`; and the evidence
 * allowlist is single-sourced here rather than as a fragile multi-clause expression.
 *
 * Detection is of FORM (a claim with no evidence call), not substance — same
 * contract as verify-before-claiming. Fail-open: a missing/unreadable flag → allow.
 */
import { z } from 'zod';

import { atomicWriteFile } from '../runtime/atomic_write.js';
import { sessionStateFile } from '../runtime/paths.js';
import { ok } from '../runtime/result.js';
import { readSessionStateValue, readSessionToolLedger } from '../runtime/session_state.js';

import type { FunctionRegistry } from './registry.js';

/** Session-state key shared with `verify-before-claiming`'s write_state step. */
export const UNBACKED_CLAIM_KEY = 'unbacked-claim';

const Args = z.object({ evidence_tools: z.array(z.string()).default([]) }).strict();

export function registerClaimEvidenceGate(registry: FunctionRegistry): void {
  registry.register({
    name: 'claim_evidence_gate',
    argSchema: Args,
    durable: false,
    memoizable: false,
    costEstimateMs: 2,
    execute: async (args, ctx) => {
      const flag = await readSessionStateValue(ctx.sessionId, UNBACKED_CLAIM_KEY);
      if (flag === null || flag === undefined) return ok({ blocked: false });
      if (ctx.event.kind !== 'tool_call') return ok({ blocked: false });

      const tool = ctx.event.tool;
      const evidence = new Set(args.evidence_tools);
      const { tools } = await readSessionToolLedger(ctx.sessionId, 'current_turn');

      // The current tool IS evidence, OR evidence was already gathered this turn →
      // clear the flag and allow (evidence tools must never be blocked).
      if (evidence.has(tool) || tools.some((t) => evidence.has(t))) {
        await atomicWriteFile(sessionStateFile(ctx.sessionId, UNBACKED_CLAIM_KEY), 'null');
        return ok({ blocked: false });
      }

      const raw =
        typeof flag === 'object' && flag !== null && 'phrases' in flag ? flag.phrases : flag;
      const phrases = typeof raw === 'string' ? raw : JSON.stringify(raw);
      return ok({ blocked: true, phrases });
    },
  });
}
