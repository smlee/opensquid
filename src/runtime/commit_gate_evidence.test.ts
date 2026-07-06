import { describe, expect, it } from 'vitest';

import { readCommitGateEvidence } from './commit_gate_evidence.js';

// scope-4 (T-deploy-commit-gate §4a): the commit-gate evidence is PACK-DECLARED and read module-relative to the
// opensquid package (the `read_rubric` precedent), NOT the consumer's cwd. These tests prove core reads whatever
// the active pack declares — so the `fullstack-flow-code-audit-cache` key lives in the PACK, not a core literal.
describe('readCommitGateEvidence (scope-4 §4a — pack-declared commit-gate evidence)', () => {
  it('fullstack-flow (v2) → the pack-declared evidence set (audit key + ledger + scope-5 suite backstop)', async () => {
    const ev = await readCommitGateEvidence('fullstack-flow');
    expect(ev).toEqual({
      auditCacheKey: 'fullstack-flow-code-audit-cache',
      requirePhaseLedger: true,
      requireSuiteGreen: true, // scope-5 (§5.4): the gate independently requires suite-green
    });
  });

  it('coding-flow (v1, no pack.yaml / no commit_gate) → null (keeps the session-FSM gate path)', async () => {
    expect(await readCommitGateEvidence('coding-flow')).toBeNull();
  });

  it('an unknown pack → null (fail-soft: no evidence declared, never throws)', async () => {
    expect(await readCommitGateEvidence('no-such-pack-xyz')).toBeNull();
  });
});
