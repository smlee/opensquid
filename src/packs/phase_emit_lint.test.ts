import { describe, expect, it } from 'vitest';

import { lintPhaseEmits } from './phase_emit_lint.js';

describe('lintPhaseEmits', () => {
  it('requires log_phase only when the opaque state declares a phase ledger', () => {
    const [pass] = lintPhaseEmits([
      { stage: 'delta', phases: ['one', 'two'], text: 'Call log_phase(<phase>) after each.' },
    ]);
    expect(pass?.ok).toBe(true);

    const [fail] = lintPhaseEmits([
      { stage: 'delta', phases: ['one', 'two'], text: 'Do both steps.' },
    ]);
    expect(fail?.missing).toContain(
      "state 'delta' declares phases but its procedure has no log_phase( mandate",
    );
  });

  it('does not impose a phase emitter on states without a declaration', () => {
    const [result] = lintPhaseEmits([{ stage: 'omega', text: 'Do the pack procedure.' }]);
    expect(result?.ok).toBe(true);
  });

  it('rejects the retired silent-feed promise for every state', () => {
    const [result] = lintPhaseEmits([
      { stage: 'anything', text: 'Without this call, the stage is silent.' },
    ]);
    expect(result?.missing).toContain('carries the retired set_loop_phase "silent" false promise');
  });
});
