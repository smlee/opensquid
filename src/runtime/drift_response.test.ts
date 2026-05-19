/**
 * Tests for the drift-response dispatcher (`applyDriftResponse`).
 *
 * Per Task 1.6 acceptance criteria: ≥ 3 cases here, ≥ 6 across this file +
 * `functions/verdict.test.ts`. Coverage:
 *
 *   - `block_tool` → { kind: 'block_tool', message }
 *   - `warn` → { kind: 'warn', message }
 *   - `full_stop_and_redo` → { kind: 'halt', reason }
 *   - `notify_and_pause` → { kind: 'notify_pause', severity: 'error' }
 *   - Unknown policy (cast through `DriftPolicy`) → fail-safe
 *     `{ kind: 'notify_pause', severity: 'critical' }` (constraint C10).
 *
 * The unknown-policy case exists to lock in the C10 contract — silent
 * fail-open is forbidden. The test casts a bogus string through
 * `DriftPolicy` to simulate a pack-author typo that slipped past schema
 * validation (or a future policy variant a downstream consumer hasn't yet
 * learned about).
 */

import { describe, expect, it } from 'vitest';

import { applyDriftResponse } from './drift_response.js';
import type { DriftPolicy, Verdict } from './types.js';

const baseVerdict: Verdict = { level: 'block', message: 'never amend' };

describe('applyDriftResponse', () => {
  it('block_tool policy → { kind: "block_tool", message }', () => {
    const action = applyDriftResponse(baseVerdict, 'block_tool');
    expect(action).toEqual({ kind: 'block_tool', message: 'never amend' });
  });

  it('warn policy → { kind: "warn", message }', () => {
    const action = applyDriftResponse(baseVerdict, 'warn');
    expect(action).toEqual({ kind: 'warn', message: 'never amend' });
  });

  it('full_stop_and_redo policy → { kind: "halt", reason }', () => {
    const action = applyDriftResponse(baseVerdict, 'full_stop_and_redo');
    expect(action).toEqual({ kind: 'halt', reason: 'never amend' });
  });

  it('notify_and_pause policy → { kind: "notify_pause", severity: "error" }', () => {
    const action = applyDriftResponse(baseVerdict, 'notify_and_pause');
    expect(action).toEqual({
      kind: 'notify_pause',
      reason: 'never amend',
      severity: 'error',
    });
  });

  it('unknown policy → fail-safe notify_pause with severity "critical" (C10)', () => {
    // Cast a bogus string through `DriftPolicy` to simulate a pack-author
    // typo or a future policy variant. The dispatcher must NOT silently
    // default — it must surface the unknown policy via severity 'critical'.
    const action = applyDriftResponse(baseVerdict, 'mystery_policy' as DriftPolicy);

    expect(action.kind).toBe('notify_pause');
    if (action.kind === 'notify_pause') {
      expect(action.severity).toBe('critical');
      expect(action.reason).toContain('Unknown policy');
      expect(action.reason).toContain('mystery_policy');
    }
  });
});
