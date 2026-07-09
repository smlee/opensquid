/**
 * LMP.3 — the no-silent-stage lint unit. (The LIVE path — the lint over the 6 real built-in procedures — is in
 * fullstack_flow_pack.test.ts.) Here we pin the pure verdict: a stage passes iff it has ≥1 set_loop_phase emit
 * AND an enter+leave pair; a failure NAMES the missing half.
 */
import { describe, expect, it } from 'vitest';

import { lintPhaseEmits } from './phase_emit_lint.js';

describe('lintPhaseEmits', () => {
  it('passes a stage with an enter+leave pair', () => {
    const [r] = lintPhaseEmits([
      {
        stage: 'code',
        text: 'set_loop_phase(phase: "test", lifecycle: "running") … set_loop_phase(phase: "test", lifecycle: "done")',
      },
    ]);
    expect(r?.ok).toBe(true);
    expect(r?.missing).toEqual([]);
  });

  it('fails a stage with NO set_loop_phase emit (log_phase only) and names the gap', () => {
    const [r] = lintPhaseEmits([{ stage: 'x', text: 'log_phase(pre_research) done' }]);
    expect(r?.ok).toBe(false);
    expect(r?.missing).toContain('no set_loop_phase emit');
  });

  it('fails a stage with an enter emit but no lifecycle:"done" leave', () => {
    const [r] = lintPhaseEmits([
      { stage: 'y', text: 'set_loop_phase(phase: "code", lifecycle: "running")' },
    ]);
    expect(r?.ok).toBe(false);
    expect(r?.missing).toContain('no leave (lifecycle:"done") emit');
  });

  it('is presence-based, not count-based (a 3-phase and a 7-phase stage both pass)', () => {
    const text3 = 'set_loop_phase(a, lifecycle: "running") set_loop_phase(a, lifecycle: "done")';
    const results = lintPhaseEmits([
      { stage: 'scope', text: text3 },
      { stage: 'code', text: text3 },
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
  });
});
