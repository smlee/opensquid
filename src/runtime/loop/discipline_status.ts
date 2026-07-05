/**
 * Discipline status inspector (T-v2-audit F5) — the answer to "we have no proper process to know the v2 state
 * besides watching the terminal." Aggregates, for a session, the LIVE v2 discipline state from the same on-disk
 * sources the runtime uses (not a separate store that could drift):
 *   - the active task (active-task.json) — null ⇒ the discipline is DORMANT (no in_progress task to key off);
 *   - per active v2 pack: the per-task FSM state + EVERY gate's pass/fail evaluated through the REAL
 *     RegistryGuardEvaluator over buildGuardCtx (the exact predicates the hooks enforce), with each guard's
 *     expression so the failing facet is visible;
 *   - the stage reports SAVED under `<project>/.opensquid/reports/` (V2-ENF.2/4, not the legacy docs/reports/).
 *
 * The gate evaluation uses a NEUTRAL `post_tool_call` event (no tool), so it reports the STANDING gate state —
 * "if a transition were attempted right now, which gates hold" — not an action-specific verdict. Read-only: it
 * NEVER advances the FSM or writes state. Reused by the `opensquid status` CLI + (optionally) an MCP tool.
 */
import { readdir } from 'node:fs/promises';

import { loadActiveV2Cartridges } from '../bootstrap.js';
import { projectReportsDirFor } from './reports_dir.js';
import { readFsmState } from '../fsm_state.js';
import { readActiveTask, readActiveTaskId, readSessionCwd } from '../session_state.js';
import type { Event } from '../types.js';

import { buildGuardCtx } from './v2_supply.js';
import { RegistryGuardEvaluator } from './guard_evaluator.js';

export interface GateStatus {
  ref: string;
  expr: string;
  pass: boolean;
}

export interface PackStatus {
  pack: string;
  fsmState: string;
  gates: GateStatus[];
}

export interface DisciplineStatus {
  sessionId: string;
  /** null ⇒ no in_progress task ⇒ the discipline is dormant (nothing to gate). */
  activeTask: { id: string; subject: string } | null;
  dormant: boolean;
  packs: PackStatus[];
  reports: string[];
}

/** Build the live discipline status for a session. Read-only; never advances the FSM. */
export async function disciplineStatus(sessionId: string): Promise<DisciplineStatus> {
  const cartridges = await loadActiveV2Cartridges(sessionId);
  const taskId = await readActiveTaskId(sessionId);
  const task = await readActiveTask(sessionId);

  // Neutral standing-state event: a post_tool_call with no tool is not any gate's advance-action, so the result
  // reflects the current gate facts rather than an action-specific verdict.
  const event = { kind: 'post_tool_call' } as unknown as Event;

  const packs: PackStatus[] = [];
  for (const c of cartridges) {
    const fsm = c.compiled.fsm;
    if (fsm === undefined) continue; // foundation cartridge — not an observed FSM
    const name = c.pack.name;
    const fsmState = await readFsmState(sessionId, name, fsm, taskId);
    const gates: GateStatus[] = [];
    const exprs = c.compiled.guardExprs;
    if (exprs !== undefined && exprs.size > 0) {
      let ctx: Map<string, unknown>;
      try {
        ctx = await buildGuardCtx(event, sessionId, fsmState);
      } catch {
        ctx = new Map();
      }
      const evaluator = new RegistryGuardEvaluator(exprs);
      for (const [ref, expr] of exprs) {
        let pass: boolean;
        try {
          pass = evaluator.eval(ref, ctx);
        } catch {
          pass = false; // a malformed/unevaluable guard fails closed in the report (mirrors enforcement)
        }
        gates.push({ ref, expr, pass });
      }
    }
    packs.push({ pack: name, fsmState, gates });
  }

  let reports: string[] = [];
  const root = await readSessionCwd(sessionId);
  if (root !== null) {
    // V2-ENF.2/4 — SAVED reports live under `<project>/.opensquid/reports/`, not the legacy `docs/reports/`.
    const reportsDir = await projectReportsDirFor(root);
    if (reportsDir !== null) {
      try {
        reports = (await readdir(reportsDir)).filter((f) => f.endsWith('.md')).sort();
      } catch {
        // no reports dir yet — leave empty
      }
    }
  }

  return {
    sessionId,
    activeTask: task !== null ? { id: task.id, subject: task.subject } : null,
    dormant: taskId === null,
    packs,
    reports,
  };
}

/** Render a discipline status as a human-readable block for the CLI. */
export function formatDisciplineStatus(s: DisciplineStatus): string {
  const lines: string[] = [];
  lines.push(`🦑 opensquid v2 discipline — session ${s.sessionId}`);
  if (s.activeTask === null) {
    lines.push(
      '• Active task: none — the discipline is DORMANT (no in_progress task to gate off).',
    );
  } else {
    lines.push(`• Active task: ${s.activeTask.id} — "${s.activeTask.subject}"`);
  }
  if (s.packs.length === 0) {
    lines.push('• v2 packs: none active.');
  }
  for (const p of s.packs) {
    lines.push(`• Pack ${p.pack} — FSM state: ${p.fsmState}`);
    for (const g of p.gates) {
      lines.push(`    ${g.pass ? '✅' : '⛔'} ${g.ref.padEnd(20)} ${g.expr}`);
    }
  }
  lines.push(
    s.reports.length > 0
      ? `• Reports emitted (.opensquid/reports/): ${s.reports.join(', ')}`
      : '• Reports emitted: none yet.',
  );
  return lines.join('\n');
}
