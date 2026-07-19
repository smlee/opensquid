/** Pack-data lint for declared sub-phase monitor coverage. */
export interface ProcedureLintResult {
  stage: string;
  ok: boolean;
  missing: string[];
}

/**
 * Any opaque state that declares a phase ledger must tell its process to call `log_phase`. States without a
 * phase declaration have no such requirement. No state id or phase vocabulary is distinguished in core.
 */
export function lintPhaseEmits(
  procedures: { stage: string; text: string; phases?: readonly string[] }[],
): ProcedureLintResult[] {
  return procedures.map(({ stage, text, phases }) => {
    const missing: string[] = [];
    if (phases !== undefined && phases.length > 0 && !/log_phase\s*\(/.test(text)) {
      missing.push(`state '${stage}' declares phases but its procedure has no log_phase( mandate`);
    }
    if (/without this[^.]*silent/i.test(text)) {
      missing.push('carries the retired set_loop_phase "silent" false promise');
    }
    return { stage, ok: missing.length === 0, missing };
  });
}
