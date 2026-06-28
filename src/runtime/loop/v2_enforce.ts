/**
 * V2 gate ENFORCEMENT in PreToolUse (the fix for "gates can't block").
 *
 * Per the Claude Code hooks contract, ONLY a PreToolUse hook can block a tool before it runs (via
 * `permissionDecision: "deny"`); a PostToolUse hook is too late (the tool already ran). The v2 stage gates
 * trigger on `post_tool_call`, so they advance the FSM + emit reports AFTER an action, but they cannot prevent
 * one — which is why the discipline never actually blocked anything. This module restores enforcement by
 * evaluating the relevant gate guard BEFORE the action, in pre-tool-use.
 *
 * It enforces the one v2 gate that blocks an action v1 does NOT already cover:
 *   - SCOPE (`scope_ready`) on a Write/Edit of `docs/research/*-pre-research-*` — T2.4 `is_advance`; the guard's
 *     own `!scope.is_advance` short-circuit means it only blocks the not-ready advance, never mid-scoping.
 * The CODE commit gate is deliberately NOT enforced here: v1's `phase-logged-before-commit` already gates a
 * commit on the 7-phase ledger (satisfiable via `log_phase`), whereas v2's `code_ready` additionally requires
 * `readiness_ran` which has no interactive way to satisfy — enforcing it would brick every commit. PLAN/AUTHOR/
 * DEPLOY stay PROGRESSION gates (advance + report on post). The run-to-done turn-end pause is the OTHER new v2
 * enforcement (`runToDoneStopBlock`, below).
 *
 * Cheap by construction: the (expensive) `buildGuardCtx` is built ONLY when the pending action is the SCOPE
 * advance-action — every other tool returns PASS immediately. FAIL-OPEN: any error never blocks.
 */
import { loadActiveV2Cartridges } from '../bootstrap.js';
import type { Event } from '../types.js';
import { isAutomationFlagSet } from '../automation_state.js';
import { readFsmStateFile } from '../fsm_state.js';

import { buildGuardCtx } from './v2_supply.js';
import { RegistryGuardEvaluator } from './guard_evaluator.js';
import { defaultCodeEvidenceDeps } from './code_evidence.js';

export interface V2EnforceResult {
  exitCode: 0 | 2;
  message: string;
}
const PASS: V2EnforceResult = { exitCode: 0, message: '' };

/** The pending action → the gate guard that enforces it (its advance-action), or null when no gate applies. */
function gateForAction(event: Event): { guardRef: string; state: string } | null {
  if (!('tool' in event)) return null;
  const args = 'args' in event ? event.args : undefined;
  const filePath = typeof args?.file_path === 'string' ? args.file_path : '';
  // SCOPE gate: writing a pre-research artifact (T2.4 is_advance); scope_ready short-circuits non-advances.
  // (CODE commit-gating is intentionally left to v1's phase-logged-before-commit — see module doc.)
  if (
    (event.tool === 'Write' || event.tool === 'Edit') &&
    /docs\/research\/.*-pre-research-/.test(filePath)
  ) {
    return { guardRef: 'scope_ready', state: 'scope' };
  }
  return null;
}

/**
 * Enforce the v2 discipline gates for a PENDING tool call. Returns `{exitCode: 2, message}` to DENY when the
 * action's gate guard fails; `{exitCode: 0}` otherwise (and for every non-advance action). Caller emits the
 * deny as a PreToolUse `permissionDecision: "deny"`.
 */
export async function enforceV2GatesPre(sessionId: string, event: Event): Promise<V2EnforceResult> {
  const match = gateForAction(event);
  if (match === null) return PASS;
  try {
    const cartridges = await loadActiveV2Cartridges(sessionId);
    for (const c of cartridges) {
      const exprs = c.compiled.guardExprs;
      if (exprs === undefined) continue;
      if (!exprs.has(match.guardRef)) continue;
      const ctx = await buildGuardCtx(event, sessionId, match.state);
      const pass = new RegistryGuardEvaluator(exprs).eval(match.guardRef, ctx);
      if (!pass) {
        const msg =
          c.compiled.meta[match.state]?.onFail?.message ?? `${match.state} gate not ready`;
        return { exitCode: 2, message: `🦑 [${match.state} gate] ${msg}` };
      }
    }
  } catch (err) {
    process.stderr.write(`[v2-enforce] gate enforcement error (ignored): ${String(err)}\n`);
  }
  return PASS;
}

/**
 * V2 — the run-to-done STOP gate (AF.6/AF.7 "past SCOPE there are no pauses; run to done").
 *
 * In AUTOMATION mode, if the active task's fullstack-flow FSM is PAST SCOPE and not terminal, return a reason
 * to BLOCK the turn-end (the caller emits `{decision:"block",reason}` so the autonomous lap CONTINUES to DEPLOY
 * instead of pausing mid-run). Returns null to allow the stop.
 *
 * AUTOMATION-SCOPED on purpose: blocking turn-end in an INTERACTIVE session would trap the human (they could
 * never reply) — "it runs by itself" is the autonomous-run model. FAIL-OPEN: any error → allow the stop.
 */
export async function runToDoneStopBlock(sessionId: string): Promise<string | null> {
  try {
    if (!(await isAutomationFlagSet(sessionId))) return null; // interactive: the human drives — never trap
    const taskId = await defaultCodeEvidenceDeps.activeTaskId(sessionId);
    if (taskId === null) return null; // nothing in flight
    const state = (await readFsmStateFile(sessionId, 'fullstack-flow', taskId))?.state;
    // Allow the stop only at the interactive boundary (scope) or a terminal (done/accept); else: run to done.
    if (state === undefined || state === 'scope' || state === 'done' || state === 'accept')
      return null;
    return `🦑 run to done — past SCOPE there are no pauses (AF.6/AF.7); continue task ${taskId} (stage: ${state}) to DEPLOY.`;
  } catch {
    return null; // fail-open: never trap the turn on an error
  }
}
