/** GUARD.1 — the completion connector (liveness + safety contract). */
import { describe, expect, it } from 'vitest';

import { evaluateCompletion } from './connector.js';

describe('completion connector (GUARD.1)', () => {
  it('SAFETY: a degenerate loop (floor halt) breaks → wedge, even if the guard held', () => {
    expect(evaluateCompletion({ completionGuardHeld: true, floorAction: 'halt' })).toEqual({
      kind: 'break',
      reason: 'progress-floor-degenerate',
    });
  });

  it('LIVENESS: terminal + completion guard held → release (advance)', () => {
    expect(evaluateCompletion({ completionGuardHeld: true, floorAction: 'pass' })).toEqual({
      kind: 'release',
    });
  });

  it('ANTI-SELF-GRADING: claims-done but guard fails → continue (no release)', () => {
    expect(evaluateCompletion({ completionGuardHeld: false, floorAction: 'pass' })).toEqual({
      kind: 'continue',
    });
  });

  it('a block (not halt) does NOT break the loop — it self-continues', () => {
    // block is a per-call deny + self-continue, not a loop-ending degeneracy
    expect(evaluateCompletion({ completionGuardHeld: false, floorAction: 'block' })).toEqual({
      kind: 'continue',
    });
  });

  it('a warn never blocks release when the guard holds', () => {
    expect(evaluateCompletion({ completionGuardHeld: true, floorAction: 'warn' })).toEqual({
      kind: 'release',
    });
  });

  it('safety outranks liveness: halt breaks even with the guard held and a release otherwise due', () => {
    const verdict = evaluateCompletion({ completionGuardHeld: true, floorAction: 'halt' });
    expect(verdict.kind).toBe('break');
  });
});
