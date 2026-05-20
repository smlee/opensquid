/**
 * Tests for the drift-response dispatcher (`applyDriftResponse`).
 *
 * Coverage:
 *
 *   - `block_tool` → { kind: 'block_tool', message }
 *   - `warn` → { kind: 'warn', message }
 *   - `full_stop_and_redo` → { kind: 'halt', reason }
 *   - `notify_and_pause` → { kind: 'notify_pause', severity: 'error' }
 *   - `auto_correct` (AUTO.4) → { kind: 'auto_correct', correctiveSkill, verdict }
 *   - `auto_correct` w/ missing corrective-skill entry → fail-safe
 *     notify_pause with severity 'critical' (C10).
 *   - `auto_correct` w/ verdict lacking ruleId → fail-safe notify_pause (C10).
 *   - `escalate` (AUTO.4) → { kind: 'escalate', reroutedSeverity: 'critical', verdict }
 *   - Unknown policy (cast through `DriftPolicy`) → fail-safe
 *     `{ kind: 'notify_pause', severity: 'critical' }` (constraint C10).
 *
 * The unknown-policy case + missing-corrective-skill cases exist to lock in
 * the C10 contract — silent fail-open is forbidden.
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

  it('auto_correct policy → { kind: "auto_correct", correctiveSkill, verdict }', () => {
    const ruled: Verdict = { ...baseVerdict, ruleId: 'format-violation' };
    const action = applyDriftResponse(ruled, 'auto_correct', {
      correctiveSkills: { 'format-violation': 'auto-format-skill' },
    });
    expect(action).toEqual({
      kind: 'auto_correct',
      correctiveSkill: 'auto-format-skill',
      verdict: ruled,
    });
  });

  it('auto_correct w/ missing corrective-skill entry → notify_pause critical (C10)', () => {
    const ruled: Verdict = { ...baseVerdict, ruleId: 'format-violation' };
    const action = applyDriftResponse(ruled, 'auto_correct', { correctiveSkills: {} });
    expect(action.kind).toBe('notify_pause');
    if (action.kind === 'notify_pause') {
      expect(action.severity).toBe('critical');
      expect(action.reason).toContain('format-violation');
      expect(action.reason).toContain('corrective_skills');
    }
  });

  it('auto_correct w/ verdict missing ruleId → notify_pause critical (C10)', () => {
    const action = applyDriftResponse(baseVerdict, 'auto_correct', {
      correctiveSkills: { 'format-violation': 'auto-format-skill' },
    });
    expect(action.kind).toBe('notify_pause');
    if (action.kind === 'notify_pause') {
      expect(action.severity).toBe('critical');
      expect(action.reason).toContain('ruleId');
    }
  });

  it('escalate policy → { kind: "escalate", reroutedSeverity: "critical", verdict }', () => {
    const action = applyDriftResponse(baseVerdict, 'escalate');
    expect(action).toEqual({
      kind: 'escalate',
      reroutedSeverity: 'critical',
      verdict: baseVerdict,
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
