/**
 * LMP.3 (REPURPOSED — T-deterministic-phase-monitor scope-3) — the no-silent-stage pack-lint.
 *
 * The no-silent-stage guarantee is now ENFORCED, not discretionary: CODE's 7 sub-phases ride the enforced
 * `log_phase` derivation (log_phase.ts, scope-1) and EVERY stage appears at stage granularity via the enforced
 * `stage_advance` from `upsertTaskStage` (loop_stage.ts:128, scope-2). So the lint's job flips from "each stage
 * must contain a discretionary `set_loop_phase(` emit" (the mechanism this task RETIRED) to guarding the enforced
 * feed source: a procedure passes iff (a) the CODE procedure DRIVES the enforced feed — it contains a `log_phase(`
 * mandate covering its phases — and (b) NO procedure presents `set_loop_phase` as REQUIRED for a stage to APPEAR
 * (i.e. it carries no retired "Without this … silent" false promise). `set_loop_phase` stays an OPTIONAL
 * running-granularity supplement everywhere; a non-code procedure is NOT required to emit it. PURE (text in,
 * verdict out). Wired into the pack test (the live CI path) so a CODE procedure that drops its `log_phase` mandate
 * — which would silently break the deterministic feed — fails the build.
 *
 * The live authority for "the enforced feed actually fires + streams" is the `phase_leave` event round-trip
 * (log_phase.test.ts / loop_events.test.ts); this lint is the cheap static guard that keeps the procedures honest.
 *
 * Imports from: none (pure).
 * Imported by: src/packs/fullstack_flow_pack.test.ts (the CI live path), src/packs/phase_emit_lint.test.ts.
 */

/** One procedure stage's lint verdict — `missing` NAMES the gap so a failure points at the offending stage. */
export interface ProcedureLintResult {
  stage: string;
  ok: boolean;
  missing: string[];
}

/**
 * A procedure passes iff it does NOT rely on the discretionary `set_loop_phase` to APPEAR: the CODE stage must
 * DRIVE the enforced feed (a `log_phase(` mandate is present) and NO stage may carry the retired "Without this …
 * silent" false promise. `set_loop_phase` is an OPTIONAL supplement everywhere — a non-code stage is not required
 * to emit it (it already appears via the enforced `stage_advance`).
 */
export function lintPhaseEmits(
  procedures: { stage: string; text: string }[],
): ProcedureLintResult[] {
  return procedures.map(({ stage, text }) => {
    const missing: string[] = [];
    if (stage === 'code' && !/log_phase\s*\(/.test(text)) {
      missing.push('CODE must drive the enforced log_phase feed (no log_phase( mandate)');
    }
    if (/without this[^.]*silent/i.test(text)) {
      missing.push('carries the retired set_loop_phase "silent" false promise');
    }
    return { stage, ok: missing.length === 0, missing };
  });
}
