/**
 * LMP.3 (REPURPOSED — T-deterministic-phase-monitor scope-3) — the no-silent-stage lint unit. (The LIVE path —
 * the lint over the 6 real built-in procedures — is in fullstack_flow_pack.test.ts.) Here we pin the pure
 * verdict against the ENFORCED-feed invariant: the CODE procedure must DRIVE `log_phase(`, and NO procedure may
 * carry the retired "Without this … silent" false promise; a failure NAMES the gap. `set_loop_phase` is an
 * OPTIONAL supplement everywhere (a non-code stage is not required to emit it — it appears via `stage_advance`).
 */
import { describe, expect, it } from 'vitest';

import { lintPhaseEmits } from './phase_emit_lint.js';

describe('lintPhaseEmits', () => {
  it('passes a CODE stage that drives the enforced log_phase feed', () => {
    const [r] = lintPhaseEmits([
      {
        stage: 'code',
        text: 'Log ALL 7 via log_phase(<phase>) as you complete them — the enforced feed.',
      },
    ]);
    expect(r?.ok).toBe(true);
    expect(r?.missing).toEqual([]);
  });

  it('fails a CODE stage that dropped the log_phase mandate and names the gap', () => {
    const [r] = lintPhaseEmits([
      {
        stage: 'code',
        text: 'run the 7 phases; emit set_loop_phase(phase: "code", lifecycle: "done")',
      },
    ]);
    expect(r?.ok).toBe(false);
    expect(r?.missing).toContain(
      'CODE must drive the enforced log_phase feed (no log_phase( mandate)',
    );
  });

  it('a NON-code stage is NOT required to emit set_loop_phase (it appears via stage_advance)', () => {
    const [r] = lintPhaseEmits([
      {
        stage: 'scope',
        text: 'Research first; write the pre-research artifact. (Optional) set_loop_phase.',
      },
    ]);
    expect(r?.ok).toBe(true);
    expect(r?.missing).toEqual([]);
  });

  it('a non-code stage with NO phase emit at all still passes (stage_advance covers it)', () => {
    const [r] = lintPhaseEmits([
      { stage: 'plan', text: 'Decompose the scope into a work-graph. No emits.' },
    ]);
    expect(r?.ok).toBe(true);
    expect(r?.missing).toEqual([]);
  });

  it('fails ANY stage that carries the retired "Without this … silent" false promise', () => {
    const [r] = lintPhaseEmits([
      {
        stage: 'code',
        text: 'log_phase(<phase>). Without this, CODE — the longest stage — is SILENT on the feed.',
      },
    ]);
    expect(r?.ok).toBe(false);
    expect(r?.missing).toContain('carries the retired set_loop_phase "silent" false promise');
  });
});
