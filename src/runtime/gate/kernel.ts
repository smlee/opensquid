/**
 * KERN.1 — the gate-action kernel (T-fsm-actor-runtime §KERN.1).
 *
 * Exactly 4 actions, pure, keyed by name — replacing the 6-policy `applyDriftResponse`
 * table (`drift_response.ts`). pass/warn = AID (proceed); block/halt = ENFORCE.
 * `block`/`halt` carry the failure-type-keyed instruction from the pack's `messages`
 * store, so the agent SELF-CONTINUES (no `auto_correct`/`escalate`). A `halt` is a
 * WEDGE — or HUMAN_REQUIRED when a dangerous action has no approver (the thin residual).
 *
 * Borrows Hermes's action ladder (allow/warn/block/halt, `tool_guardrails.py`) in
 * opensquid's namespace. INV2: every fired action publishes a `gate_action` transition
 * (enforcement is observable) — you cannot enforce without observing.
 */
import type { Bus } from '../bus/bus.js';
import type { ActorAddr } from '../bus/types.js';

export type Action = 'pass' | 'warn' | 'block' | 'halt';
export type Verdict = 'WEDGE' | 'HUMAN_REQUIRED';

export interface GateEffect {
  exitCode: 0 | 2; // 0 = proceed (pass/warn); 2 = enforce (block/halt)
  message?: string; // the injected (failure-typed) instruction
  verdict?: Verdict; // halt only
}

export interface GateCtx {
  bus: Bus;
  from: ActorAddr;
  /** a DANGEROUS-tier action in an autonomous loop with no approver → HUMAN_REQUIRED, not WEDGE. */
  humanRequired?: boolean;
}

// Pure action functions keyed by name (the only non-composable kernel).
const ACTIONS: Record<Action, (message: string, ctx: GateCtx) => GateEffect> = {
  pass: () => ({ exitCode: 0 }),
  warn: (message) => ({ exitCode: 0, message }), // proceed + nudge
  block: (message) => ({ exitCode: 2, message }), // deny this action; inject instruction → agent self-continues
  halt: (message, ctx) => ({
    exitCode: 2,
    message,
    verdict: ctx.humanRequired ? 'HUMAN_REQUIRED' : 'WEDGE',
  }),
};

/**
 * Apply a gate action: look up the failure-typed instruction (safe default on an unknown key),
 * run the pure action, and — for any non-`pass` action — publish a `gate_action` transition (INV2).
 */
export function applyAction(
  action: Action,
  failureType: string,
  messages: Record<string, string>,
  ctx: GateCtx,
): GateEffect {
  const message = messages[failureType] ?? `gate:${action}`; // never throws on an unknown failure type
  const effect = ACTIONS[action](message, ctx);
  if (action !== 'pass') {
    // enforcement IS a transition — observable on the bus (INV2)
    ctx.bus.publish({
      from: ctx.from,
      to: 'topic:transition',
      kind: 'gate_action',
      payload: { action, failureType },
    });
  }
  return effect;
}
