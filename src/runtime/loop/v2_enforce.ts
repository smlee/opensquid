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
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { loadActiveV2Cartridges } from '../bootstrap.js';
import type { Event } from '../types.js';
import { readFsmState } from '../fsm_state.js';
import { readActiveTaskId, readSessionCwd } from '../session_state.js';

import { buildGuardCtx } from './v2_supply.js';
import { openWg } from './plan_evidence.js';
import { RegistryGuardEvaluator } from './guard_evaluator.js';
import { frontendEvidenceForEvent } from './frontend_evidence.js';

export interface V2EnforceResult {
  exitCode: 0 | 2;
  message: string;
}
const PASS: V2EnforceResult = { exitCode: 0, message: '' };

/** Source-code extensions the scope-before-code entry-guard covers (NOT docs/config/research). */
const SOURCE_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|vue|svelte|astro|c|cc|cpp|h|hpp|cs|kt|swift|scala|sql)$/i;

/**
 * THE ENTRY-GUARD (the force-into-the-loop enforcement — T-entry-guard / design §1 "discipline in the
 * machinery, not the AI's good intentions"). Blocks a SOURCE-CODE Write/Edit when the active task has NOT
 * cleared SCOPE. This is what makes the discipline non-bypassable: you cannot write code until you've scoped
 * (passed the scope_ready evidence/anti-drift gate). Without it, a task can sit at SCOPE forever while code is
 * written ungated — the dormant-bypass that let drift in.
 *
 * Scoped to be safe + satisfiable: fires ONLY when fullstack-flow is active (opt-in), ONLY on source files
 * (docs/config/research pass), and ONLY while the task's FSM is still at `scope` (once scoped → code allowed).
 * Satisfiable: write the pre-research, pass the scope gate → FSM leaves `scope` → edits allowed. FAIL-OPEN:
 * any error never blocks. Returns the block message, or null to allow.
 */
async function scopeBeforeCodeBlock(sessionId: string, event: Event): Promise<string | null> {
  if (!('tool' in event) || (event.tool !== 'Write' && event.tool !== 'Edit')) return null;
  const args = 'args' in event ? event.args : undefined;
  const filePath = typeof args?.file_path === 'string' ? args.file_path : '';
  if (!SOURCE_EXT.test(filePath)) return null; // docs / config / pre-research are not gated here
  try {
    const cartridges = await loadActiveV2Cartridges(sessionId);
    const fsf = cartridges.find((c) => c.pack.name === 'fullstack-flow' && c.compiled.fsm);
    if (fsf?.compiled.fsm === undefined) return null; // discipline not active → do not enforce
    const taskId = await readActiveTaskId(sessionId);
    const state = await readFsmState(sessionId, 'fullstack-flow', fsf.compiled.fsm, taskId);
    if (state !== 'scope') return null; // SCOPE already cleared → code allowed
    return (
      '🦑 scope-before-code (entry-guard): this work has NOT cleared SCOPE, so code edits are blocked. ' +
      'The discipline must run before code — write the pre-research (anchored to the captured ask, ≥3 research ' +
      'touches, no open question) so the scope gate passes, then edit source. No evidence → no code.'
    );
  } catch {
    return null; // fail-open: an enforcement error must never break the hook
  }
}

/** Is fullstack-flow the active discipline for this session? (the report gates are opt-in like the entry-guard) */
async function fullstackActive(sessionId: string): Promise<boolean> {
  try {
    return (await loadActiveV2Cartridges(sessionId)).some((c) => c.pack.name === 'fullstack-flow');
  } catch {
    return false;
  }
}

/** Does a report `docs/reports/<prefix>-<taskId>-*.md` exist for the active task? Deterministic, satisfiable. */
async function reportExists(sessionId: string, taskId: string, prefix: string): Promise<boolean> {
  try {
    const root = await readSessionCwd(sessionId);
    if (root === null) return true; // can't resolve the project → do not block (fail-open on context)
    const files = await readdir(join(root, 'docs', 'reports')).catch(() => [] as string[]);
    return files.some((f) => f.startsWith(`${prefix}-${taskId}-`) && f.endsWith('.md'));
  } catch {
    return true; // fail-open: an unexpected error must never break the hook
  }
}

/**
 * V2-ENF.2 — MANDATORY REPORTING (non-optional, part of the loop). Two pre-gates so reporting is enforced by the
 * machinery, not the AI's memory:
 *   - PLAN report before code: block a source Write/Edit (once SCOPE is cleared) until
 *     `docs/reports/plan-<taskId>-*.md` exists — the action-plan-before-acting requirement.
 *   - COMPLETION report before commit: block `git commit` until `docs/reports/completion-<taskId>-*.md` exists —
 *     the 7-layer report-after requirement.
 * Both: only when fullstack-flow is active + there is an active task; detection by file existence (satisfiable —
 * write the report → gate clears); FAIL-OPEN on missing context. Returns the block message, or null to allow.
 */
async function reportingBlock(sessionId: string, event: Event): Promise<string | null> {
  if (!('tool' in event)) return null;
  const args = 'args' in event ? event.args : undefined;
  // COMPLETION report before a commit.
  const command = typeof args?.command === 'string' ? args.command : '';
  if (event.tool === 'Bash' && /\bgit\s+(?:-[cC]\s+\S+\s+)*commit\b/.test(command)) {
    if (!(await fullstackActive(sessionId))) return null;
    const taskId = await readActiveTaskId(sessionId);
    if (taskId === null) return null;
    if (await reportExists(sessionId, taskId, 'completion')) return null;
    return (
      `🦑 completion-report gate: write the 7-layer completion report (docs/reports/completion-${taskId}-<date>.md) ` +
      'before committing — reporting after a task is mandatory, not optional.'
    );
  }
  // PLAN report before code (after SCOPE is cleared; the entry-guard owns the pre-SCOPE block).
  const filePath = typeof args?.file_path === 'string' ? args.file_path : '';
  if ((event.tool === 'Write' || event.tool === 'Edit') && SOURCE_EXT.test(filePath)) {
    if (!(await fullstackActive(sessionId))) return null;
    const taskId = await readActiveTaskId(sessionId);
    if (taskId === null) return null; // the entry-guard handles the no-task / pre-scope case
    if (await reportExists(sessionId, taskId, 'plan')) return null;
    return (
      `🦑 plan-report gate: write the action-plan report (docs/reports/plan-${taskId}-<date>.md) before editing ` +
      'code — the plan-before-acting report is mandatory, not optional.'
    );
  }
  return null;
}

/**
 * The pending action → the gate guard that enforces it, or null when no gate applies. `ctx: 'full'` builds the
 * (expensive) buildGuardCtx; `ctx: 'frontend'` builds a CHEAP ctx with only the frontend audit fact (so a commit
 * is not made expensive by the author/code CodeIndex build).
 */
function gateForAction(
  event: Event,
): { guardRef: string; state: string; ctx: 'full' | 'frontend' } | null {
  if (!('tool' in event)) return null;
  const args = 'args' in event ? event.args : undefined;
  const filePath = typeof args?.file_path === 'string' ? args.file_path : '';
  // SCOPE gate: writing a pre-research artifact (T2.4 is_advance); scope_ready short-circuits non-advances.
  // (CODE phase/readiness commit-gating is left to v1's phase-logged-before-commit — see module doc.)
  if (
    (event.tool === 'Write' || event.tool === 'Edit') &&
    /docs\/research\/.*-pre-research-/.test(filePath)
  ) {
    return { guardRef: 'scope_ready', state: 'scope', ctx: 'full' };
  }
  // FD5/FD6 FRONTEND pre-delivery gate: a `git commit` is the delivery moment. Evaluate `frontend.clean` over a
  // CHEAP ctx (frontend evidence only). FAIL-OPEN — only a staged CRITICAL frontend defect blocks the commit.
  const command = typeof args?.command === 'string' ? args.command : '';
  if (event.tool === 'Bash' && /\bgit\s+(?:-[cC]\s+\S+\s+)*commit\b/.test(command)) {
    return { guardRef: 'code_frontend_clean', state: 'code', ctx: 'frontend' };
  }
  return null;
}

/**
 * Build the CHEAP ctx for the frontend pre-delivery gate: only the `frontend` audit fact (no CodeIndex build).
 * Dual-shape (nested `frontend` object + flat `frontend.*` keys) so the guard expression `frontend.clean`
 * path-resolves exactly as it does under buildGuardCtx.
 */
async function frontendGateCtx(event: Event): Promise<Map<string, unknown>> {
  const fe = await frontendEvidenceForEvent(event);
  const m = new Map<string, unknown>();
  m.set('frontend.clean', fe.clean);
  m.set('frontend.critical', fe.critical);
  m.set('frontend.high', fe.high);
  m.set('frontend', { clean: fe.clean, critical: fe.critical, high: fe.high });
  return m;
}

/**
 * Enforce the v2 discipline gates for a PENDING tool call. Returns `{exitCode: 2, message}` to DENY when the
 * action's gate guard fails; `{exitCode: 0}` otherwise (and for every non-advance action). Caller emits the
 * deny as a PreToolUse `permissionDecision: "deny"`.
 */
export async function enforceV2GatesPre(sessionId: string, event: Event): Promise<V2EnforceResult> {
  // ENTRY-GUARD first: source code may not be written until SCOPE is cleared (force-into-the-loop).
  const entry = await scopeBeforeCodeBlock(sessionId, event);
  if (entry !== null) return { exitCode: 2, message: entry };

  // MANDATORY REPORTING: plan report before code, completion report before commit (non-optional).
  const reporting = await reportingBlock(sessionId, event);
  if (reporting !== null) return { exitCode: 2, message: reporting };

  const match = gateForAction(event);
  if (match === null) return PASS;
  try {
    const cartridges = await loadActiveV2Cartridges(sessionId);
    for (const c of cartridges) {
      const exprs = c.compiled.guardExprs;
      if (exprs === undefined) continue;
      if (!exprs.has(match.guardRef)) continue;
      // CHEAP ctx for the frontend gate (audit fact only); FULL ctx for the SCOPE advance gate.
      const ctx =
        match.ctx === 'frontend'
          ? await frontendGateCtx(event)
          : await buildGuardCtx(event, sessionId, match.state);
      const pass = new RegistryGuardEvaluator(exprs).eval(match.guardRef, ctx);
      if (!pass) {
        if (match.guardRef === 'code_frontend_clean') {
          return {
            exitCode: 2,
            message:
              '🦑 [frontend pre-delivery gate] commit BLOCKED — staged frontend code has a CRITICAL ' +
              'accessibility defect (e.g. <img> without alt → WCAG 1.1.1, or onClick on a non-interactive ' +
              'element without role → WCAG 2.1.1). Run frontend_audit, fix the critical finding, then re-commit.',
          };
        }
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
 * In a true autonomous LAP, if the active task's fullstack-flow FSM is PAST SCOPE and not terminal, return a
 * reason to BLOCK the turn-end (the caller emits `{decision:"block",reason}` so the lap CONTINUES to DEPLOY
 * instead of pausing mid-run). Returns null to allow the stop.
 *
 * F6 (T-v2-audit): the signal is the PER-PROCESS env `OPENSQUID_AUTOMATION=1`, NOT the persistent automation
 * FLAG-FILE. The flag-file (`opensquid automation on`) bleeds across an entire session, so it would trap a HUMAN
 * who later interacts (it blocked an AskUserQuestion before this fix). Only a genuine `opensquid loop` lap process
 * carries the env (ralph.ts sets it; runOneShotCli propagates it to the lap + its hook bins), so keying the
 * turn-end BLOCK on the env fires it ONLY in real autonomous laps and never traps an interactive session.
 * FAIL-OPEN: any error → allow the stop.
 */
export async function runToDoneStopBlock(sessionId: string): Promise<string | null> {
  try {
    // The pause-gate applies whenever the DISCIPLINE is ON (fullstack-flow active) — INTERACTIVELY too, so it
    // actually stops the agent from pausing. Blocking the STOP forces the agent to CONTINUE; it does NOT trap
    // the human (the user can always interrupt to redirect). NOT automation-env-scoped — that made it inert in
    // interactive sessions (= not "live"), which was the whole bug.
    if (!(await fullstackActive(sessionId))) return null; // discipline off → no pause-gate
    // run-to-done = DRAIN THE KANBAN: block while the work-graph has READY work (listReady = open + unblocked +
    // unclaimed; excludes wedged/parked so stale work can't trap it). RALPH's BOARD_EMPTY, as a Stop-gate (AF.6/7).
    const ready = await openWg(sessionId)
      .then((wg) => wg.listReady())
      .catch(() => [] as { id: string }[]);
    if (ready.length === 0) return null; // kanban depleted → the run is done → allow the stop
    return `🦑 run to done — the kanban is NOT empty (${ready.length} ready issue${ready.length === 1 ? '' : 's'}); do not pause until the board is drained (AF.6/AF.7). Keep working — the human will interrupt to redirect.`;
  } catch {
    return null; // fail-open: never trap the turn on an error
  }
}
