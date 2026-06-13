/**
 * GR.2 — the deterministic-first decide-vs-escalate classifier + the misclassification drift recorder.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { classifyDecision, recordMisclassification } from './decision_classifier.js';

describe('classifyDecision', () => {
  it('ESCALATEs on irreversible / outward boundaries', () => {
    for (const d of [
      'should I run npm publish now?',
      'this needs the OTP to proceed',
      'force-push the rebased branch',
      'rm -rf the build dir then rebuild',
      'drop table users and recreate',
      'deploy to production',
    ]) {
      expect(classifyDecision(d).verdict).toBe('ESCALATE');
    }
  });

  it('DECIDEs on principle-settleable surface choices', () => {
    for (const d of [
      'what should I name this variable?',
      'fix the prettier formatting',
      'correct the typo in the comment',
      'which directory should this file go in?',
      'refactor this into a helper',
    ]) {
      expect(classifyDecision(d).verdict).toBe('DECIDE');
    }
  });

  it('DEFERs when there is no cheap signal (agent decides, Inv 3 → DECIDE)', () => {
    const r = classifyDecision('the third retry produced a slightly different ordering of results');
    expect(r.verdict).toBe('DEFER');
    expect(r.confidence).toBe(0);
  });

  it('ESCALATE wins over DECIDE when both fire (a boundary in a cosmetic change)', () => {
    const r = classifyDecision('rename the script then npm publish it');
    expect(r.verdict).toBe('ESCALATE');
    expect(r.matched.length).toBeGreaterThan(0);
  });
});

describe('recordMisclassification', () => {
  it('appends a surface drift event to the session catalog', async () => {
    const sid = 'gr2-test-session';
    const now = '2026-06-13T00:00:00.000Z';
    await recordMisclassification(sid, 'ESCALATE', 'DECIDE', 'should I npm publish?', now);
    const home = process.env.OPENSQUID_HOME ?? '';
    const path = join(home, 'sessions', sid, 'state', 'drift-catalog.jsonl');
    const content = await readFile(path, 'utf8');
    const last = content.trim().split('\n').at(-1) ?? '';
    const event = JSON.parse(last) as Record<string, unknown>;
    expect(event.ruleId).toBe('decision-classifier');
    expect(event.level).toBe('surface');
    expect(String(event.message)).toContain('expected ESCALATE, got DECIDE');
    expect(event.timestamp).toBe(now);
  });
});
