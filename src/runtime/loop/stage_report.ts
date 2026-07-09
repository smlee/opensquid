/**
 * T2.12 / RD.1-4 — per-stage report BODIES (SCOPE / PLAN / AUTHOR / CODE / DEPLOY).
 *
 * Each FSM stage owes a before/after COMMUNICATION report, DISPLAYED live on the terminal at the moment its
 * boundary is crossed (via `report_display.displayReport`) and NEVER persisted — RD.4 removed the
 * `.opensquid/reports/` writer these renderers used to feed (`emitStageReport`). This module is now the PURE
 * RENDER layer only: it produces the body; WHERE it prints is the `report_display` sink seam. `iso` is
 * injected, never `Date.now()`.
 *
 * STANDARDIZED FORMAT (one shape for every phase, so reports are recognizable). NB the `🦑` glyph is RESERVED
 * for drift/gate/blocked notices (reporting-model §4) — a report body NEVER carries it:
 *   After-stage report — <STAGE> complete · <taskId> · <date>
 *   Summary: …
 *   Phases:  (CODE only) a checklist chart of the 7-phase coding cycle — the long, stand-out report
 *   Next → <stage>: <what that phase will work on>
 *   Goal: …  (SCOPE only — the destination check)
 *
 * Live triggers: `v2_supply.ts` (SCOPE/PLAN/AUTHOR/DEPLOY on the leaving transition, + the CODE completion
 * fallback) + `loop_driver` (CODE on `phases_complete`). Each renders the body then DISPLAYS it live
 * (`displayReport`); the §5.4b FAILURE report keeps its own save (`reports_dir.saveProjectReport`), unchanged.
 */

// GENERIC RUNTIME — a stage LABEL is any string (the gate's declared `report:` field in pack.yaml), NOT a
// closed core enum. So a non-coding pack can name a stage outside SCOPE/PLAN/AUTHOR/CODE (e.g. REVIEW, TRIAGE)
// and the renderer is agnostic. The alias is retained for readability at the call sites.
export type Stage = string;

/** The canonical 7-phase coding cycle the CODE stage runs (the `log_phase` enum order, src/runtime/workflow_phases.ts).
 *  This mirrors the CORE phase ledger (not per-pack vocabulary), so it stays a core constant; a pack that has no
 *  phase chart simply omits `phases` from its report. */
export const CODE_PHASES = [
  'pre_research',
  'learn',
  'code',
  'test',
  'audit',
  'post_research',
  'fix',
] as const;

export interface StageReport {
  stage: Stage;
  taskId: string;
  summary: string;
  /** The next FSM state (e.g. `plan`). */
  nextDirective: string;
  /** What the next stage works on (the next state's pack-declared `does:` text) — rendered after `nextDirective`.
   *  From pack data, NOT a core map; absent ⇒ the `Next →` line names the state with no work suffix. */
  nextWork?: string;
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
  const lines: string[] = [`After-stage report — ${r.stage} complete · ${r.taskId} · ${date}`, ''];
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

  const work = r.nextWork; // pack-declared (the next state's `does:`), not a core map
  lines.push(`Next → ${r.nextDirective}${work !== undefined ? `: ${work}` : ''}`);

  if (r.goalAligned !== undefined) {
    lines.push(
      '',
      `Goal: ${r.goalAligned ? 'on the captured goal' : 'OFF the captured goal — destination drift'}`,
    );
  }

  const body = lines.join('\n') + '\n';
  // The `path` is a root-relative FILENAME only (kept for the §5.4b failure writer's dedup naming + any
  // interactive CLI that wants a suggested name). The COMMUNICATION report is DISPLAYED, never written to it
  // (RD.4 removed the `.opensquid/reports/` save); the body is the live-shown artifact.
  return { path: `${r.stage.toLowerCase()}-${r.taskId}-${date}.md`, body };
}

/**
 * Render the BEFORE-stage SUMMARY body — the "tell me what you'll be working on" line delivered on stage ENTRY
 * (the entry-edge of a transition), the counterpart to the after-stage report. Lightweight orientation: surfaced
 * in-session + chat, NOT a dated durable file (the after-report is the durable artifact). Pure (`iso` injected).
 * `work` is the entered stage's pack-declared `does:` text (from pack data, NOT a core map) — absent ⇒ a generic
 * "begin this stage".
 */
export function renderStageSummary(
  stage: Stage,
  work: string | undefined,
  taskId: string,
  iso: string,
): { body: string } {
  const date = iso.slice(0, 10);
  const lines = [
    `Starting ${stage} · ${taskId} · ${date}`,
    '',
    `Will: ${work ?? 'begin this stage'}`,
  ];
  return { body: lines.join('\n') + '\n' };
}
