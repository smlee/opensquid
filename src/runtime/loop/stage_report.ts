/**
 * T2.12 — per-stage reports (SCOPE / PLAN / AUTHOR / CODE / DEPLOY).
 *
 * Each FSM stage emits a MANDATORY report: a dated, human-readable file under the active project's
 * `docs/reports/`, a memory mirror, AND (T2.12-surface) an in-session injection + best-effort chat push —
 * so the phase status is SHOWN, not just filed. The renderer is PURE — `iso` is injected, never `Date.now()`.
 *
 * STANDARDIZED FORMAT (one shape for every phase, so reports are recognizable):
 *   🦑 Phase report — <STAGE> complete · <taskId> · <date>
 *   Summary: …
 *   Phases:  (CODE only) a checklist chart of the 7-phase coding cycle — the long, stand-out report
 *   Next → <stage>: <what that phase will work on>
 *   Goal: …  (SCOPE only — the destination check)
 *
 * Live triggers: `v2_supply.ts` (SCOPE/PLAN/AUTHOR/DEPLOY on the leaving transition) + `loop_driver` (CODE on
 * `phases_complete`). Both also surface the returned body in-session + chat.
 *
 * Imports from: node:path, ../../storage/atomic_file.
 */
import { join } from 'node:path';

import { atomicWriteFile } from '../../storage/atomic_file.js';

// 'CODE' is included (emitted by T2.9's loop_driver on phases_complete).
// 'SCOPE_WRITE' is the GS1 automated stage that writes the pre-research artifact after interactive SCOPE confirms.
export type Stage = 'SCOPE' | 'SCOPE_WRITE' | 'PLAN' | 'AUTHOR' | 'CODE' | 'DEPLOY';

/** The canonical 7-phase coding cycle the CODE stage runs (the `log_phase` enum order). */
export const CODE_PHASES = [
  'pre_research',
  'learn',
  'code',
  'test',
  'audit',
  'post_research',
  'fix',
] as const;

/** What the NEXT stage will work on — the "tell me what you'll be working on" line. Keyed by the FSM state. */
const NEXT_STAGE_WORK: Record<string, string> = {
  scope: 'capture + scope the next task (anchors resolve, depth, no open question)',
  plan: 'decompose the scope into a dependency-ordered, acyclic plan',
  author: 'author the spec + real code covering every scoped element',
  code: 'run the 7-phase coding cycle: pre_research → learn → code → test → audit → post_research → fix',
  deploy: 'verify deploy capability, then the human-accept gate',
  accepted: 'task accepted — complete',
  done: 'task complete',
};

export interface StageReport {
  stage: Stage;
  taskId: string;
  summary: string;
  /** The next FSM state (e.g. `plan`). Rendered with its NEXT_STAGE_WORK description. */
  nextDirective: string;
  /** Only the SCOPE report carries the goal-alignment line (T2.10's live consumer). Omitted → no line. */
  goalAligned?: boolean;
  /** CODE-stage step chart: which of the 7 coding phases ran. Omitted → no Phases section. */
  phases?: readonly { name: string; done: boolean }[];
  /**
   * The deterministic gate predicates that gated this phase (the evidence the transition passed) — e.g.
   * `[{label:'anchors_ok', ok:true}, …]`. Rendered as the `Evidence:` line so the report is a readable
   * proof: a phase cannot advance unless these are true, and this shows WHICH checks backed the step.
   */
  evidence?: readonly { label: string; ok: boolean }[];
}

/** Render the standardized report body + its dated file path. Pure (no `Date.now()`). */
export function renderStageReport(r: StageReport, iso: string): { path: string; body: string } {
  const date = iso.slice(0, 10);
  const lines: string[] = [`🦑 Phase report — ${r.stage} complete · ${r.taskId} · ${date}`, ''];
  lines.push(`Summary: ${r.summary}`, '');

  // Evidence line — the deterministic gate predicates that backed this phase (how you know it passed).
  if (r.evidence !== undefined && r.evidence.length > 0) {
    lines.push(
      `Evidence: ${r.evidence.map((e) => `${e.label} ${e.ok ? '✓' : '✗'}`).join(' · ')}`,
      '',
    );
  }

  // CODE (or any stage that supplies `phases`) renders the step chart — the long, stand-out report.
  if (r.phases !== undefined && r.phases.length > 0) {
    lines.push('Phases:');
    for (const p of r.phases) lines.push(`  [${p.done ? 'x' : ' '}] ${p.name}`);
    lines.push('');
  }

  const work = NEXT_STAGE_WORK[r.nextDirective];
  lines.push(`Next → ${r.nextDirective}${work !== undefined ? `: ${work}` : ''}`);

  if (r.goalAligned !== undefined) {
    lines.push(
      '',
      `Goal: ${r.goalAligned ? 'on the captured goal' : 'OFF the captured goal — destination drift'}`,
    );
  }

  const body = lines.join('\n') + '\n';
  return {
    path: join('docs/reports', `${r.stage.toLowerCase()}-${r.taskId}-${date}.md`),
    body,
  };
}

/**
 * Atomically write the rendered report and return BOTH the (root-relative) path and the body — the caller
 * surfaces the body in-session (injection) + chat + memory, which this signature's lack of a sessionId
 * keeps in the caller (v2_supply / loop_driver).
 */
export async function emitStageReport(
  root: string,
  r: StageReport,
  iso: string,
): Promise<{ path: string; body: string }> {
  const { path, body } = renderStageReport(r, iso);
  await atomicWriteFile(join(root, path), body);
  return { path, body };
}
