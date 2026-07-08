/**
 * LMP.3 — the no-silent-stage pack-lint: every procedure stage must emit its phase to the live status feed.
 *
 * The design element is EVERY procedure stage emitting an enter+leave pair, not CODE alone (§6.6). A stage
 * passes iff its procedure `.md` contains at least one `set_loop_phase(` emit AND at least one enter/leave
 * marker (a `lifecycle: "done"` token — proof the leave half is present). PURE (text in, verdict out); the lint
 * asserts PRESENCE (an emit + an enter/leave token), never a fixed emit COUNT, so a stage with a different real
 * phase count (scope's 3 vs deploy's 4 vs code's 7) still passes. Wired into the pack test (the live CI path) so
 * a regressed procedure that goes silent fails the build — the silent-stage class cannot recur for ANY stage.
 *
 * The live authority for "the emit actually fires + streams" is the `phase_enter`/`phase_leave` event round-trip
 * (loop_events.test.ts); this lint is the cheap static guard that keeps the procedures honest.
 *
 * Imports from: none (pure).
 * Imported by: src/packs/fullstack_flow_pack.test.ts (the CI live path), src/packs/phase_emit_lint.test.ts.
 */

/** One procedure stage's lint verdict — `missing` NAMES the gap so a failure points at the silent stage. */
export interface ProcedureLintResult {
  stage: string;
  ok: boolean;
  missing: string[];
}

/** A stage passes iff it emits ≥1 `set_loop_phase` AND an enter+leave pair (a `lifecycle:"done"` token). */
export function lintPhaseEmits(
  procedures: { stage: string; text: string }[],
): ProcedureLintResult[] {
  return procedures.map(({ stage, text }) => {
    const missing: string[] = [];
    if (!/set_loop_phase\s*\(/.test(text)) missing.push('no set_loop_phase emit');
    if (!/lifecycle:\s*['"]done['"]/.test(text)) missing.push('no leave (lifecycle:"done") emit');
    return { stage, ok: missing.length === 0, missing };
  });
}
