/**
 * T2.8 — deployEvidenceForSession tests (deterministic, zero LLM). Injectable deps (no live gate / ~/.opensquid):
 * the capability check (null=skip→true, boolean=verdict), the active task id, and the durable acceptance reader.
 */
import { describe, expect, it } from 'vitest';

import { deployEvidenceForSession, type DeployEvidenceDeps } from './deploy_evidence.js';

const deps = (over: Partial<DeployEvidenceDeps>): DeployEvidenceDeps => ({
  activeTaskId: () => Promise.resolve('T2.8'),
  capabilityCheck: () => Promise.resolve(null),
  acceptance: () => Promise.resolve([]),
  verificationResult: () => Promise.resolve(null), // DBL.1 — no verification configured → skip → deployClean:true
  suiteResult: () => Promise.resolve(null), // scope-1 — no suite declared → floor off (legacy project ships as today)
  reversible: () => Promise.resolve(false), // REVERSIBLE-DEPLOY — fail-closed default (irreversible)
  ...over,
});

describe('deployEvidenceForSession (T2.8)', () => {
  it('no deploy env (capabilityCheck → null) → capabilityOk:true (SKIP)', async () => {
    const ev = await deployEvidenceForSession(
      's',
      deps({ capabilityCheck: () => Promise.resolve(null) }),
    );
    expect(ev.capabilityOk).toBe(true);
  });

  it('CapabilityGate allows (true) → capabilityOk:true', async () => {
    const ev = await deployEvidenceForSession(
      's',
      deps({ capabilityCheck: () => Promise.resolve(true) }),
    );
    expect(ev.capabilityOk).toBe(true);
  });

  it('CapabilityGate denies (false) → capabilityOk:false', async () => {
    const ev = await deployEvidenceForSession(
      's',
      deps({ capabilityCheck: () => Promise.resolve(false) }),
    );
    expect(ev.capabilityOk).toBe(false);
  });

  // DBL.1 — the VERIFY facet (deployClean): skip→clean when unconfigured; the recorded result otherwise.
  it('no verification configured (verificationResult → null) → deployClean:true (SKIP, ships as today)', async () => {
    const ev = await deployEvidenceForSession(
      's',
      deps({ verificationResult: () => Promise.resolve(null) }),
    );
    expect(ev.deployClean).toBe(true);
  });

  it('verification PASSED (true) → deployClean:true (→ accept)', async () => {
    const ev = await deployEvidenceForSession(
      's',
      deps({ verificationResult: () => Promise.resolve(true) }),
    );
    expect(ev.deployClean).toBe(true);
  });

  it('verification FAILED (false) → deployClean:false (→ the AUTHOR bug-fix loop)', async () => {
    const ev = await deployEvidenceForSession(
      's',
      deps({ verificationResult: () => Promise.resolve(false) }),
    );
    expect(ev.deployClean).toBe(false);
  });

  it('verificationResult THROWS → deployClean:false (fail-closed: never ship an unverifiable build)', async () => {
    const ev = await deployEvidenceForSession(
      's',
      deps({ verificationResult: () => Promise.reject(new Error('boom')) }),
    );
    expect(ev.deployClean).toBe(false);
  });

  // scope-1 (T-deploy-commit-gate §2.1) — the SUITE is the mandatory floor; verifyCommand is additive.
  // deployClean = (suite ?? true) && (verify ?? true). The SKIP hole is CLOSED once a suite is declared.
  it('scope-1: suite PASS, no verifyCommand → deployClean:true (floor green, additive absent)', async () => {
    const ev = await deployEvidenceForSession(
      's',
      deps({
        suiteResult: () => Promise.resolve(true),
        verificationResult: () => Promise.resolve(null),
      }),
    );
    expect(ev.deployClean).toBe(true);
  });

  it('scope-1: suite FAIL, no verifyCommand → deployClean:false (the SKIP hole is CLOSED — was true)', async () => {
    const ev = await deployEvidenceForSession(
      's',
      deps({
        suiteResult: () => Promise.resolve(false),
        verificationResult: () => Promise.resolve(null),
      }),
    );
    expect(ev.deployClean).toBe(false);
  });

  it('scope-1: suite DECLARED but no record (suiteResult → false) → deployClean:false (fail-closed: run the suite)', async () => {
    const ev = await deployEvidenceForSession(
      's',
      deps({ suiteResult: () => Promise.resolve(false) }),
    );
    expect(ev.deployClean).toBe(false);
  });

  it('scope-1: suite green + verifyCommand FAIL → deployClean:false (the additive check bites)', async () => {
    const ev = await deployEvidenceForSession(
      's',
      deps({
        suiteResult: () => Promise.resolve(true),
        verificationResult: () => Promise.resolve(false),
      }),
    );
    expect(ev.deployClean).toBe(false);
  });

  it('scope-1: no suite declared (legacy) + no verifyCommand → deployClean:true (unchanged for a non-suite project)', async () => {
    const ev = await deployEvidenceForSession(
      's',
      deps({
        suiteResult: () => Promise.resolve(null),
        verificationResult: () => Promise.resolve(null),
      }),
    );
    expect(ev.deployClean).toBe(true);
  });

  it('scope-1: FAIL-CLOSED — a throwing suite reader → deployClean:false (never ship an unverifiable build)', async () => {
    const ev = await deployEvidenceForSession(
      's',
      deps({ suiteResult: () => Promise.reject(new Error('boom')) }),
    );
    expect(ev.deployClean).toBe(false);
  });

  it('FAIL-CLOSED: a throwing capability check → capabilityOk:false', async () => {
    const ev = await deployEvidenceForSession(
      's',
      deps({ capabilityCheck: () => Promise.reject(new Error('boom')) }),
    );
    expect(ev.capabilityOk).toBe(false);
  });

  it('the active task has an accepted acceptance item → accepted:true', async () => {
    const ev = await deployEvidenceForSession(
      's',
      deps({
        activeTaskId: () => Promise.resolve('T2.8'),
        acceptance: () => Promise.resolve([{ taskId: 'T2.8', status: 'accepted' }]),
      }),
    );
    expect(ev.accepted).toBe(true);
  });

  it('the active task has only a WAITING item → accepted:false (loops to plan)', async () => {
    const ev = await deployEvidenceForSession(
      's',
      deps({
        activeTaskId: () => Promise.resolve('T2.8'),
        acceptance: () => Promise.resolve([{ taskId: 'T2.8', status: 'waiting' }]),
      }),
    );
    expect(ev.accepted).toBe(false);
  });

  it('an accepted item for a DIFFERENT task → accepted:false (per-task)', async () => {
    const ev = await deployEvidenceForSession(
      's',
      deps({
        activeTaskId: () => Promise.resolve('T2.8'),
        acceptance: () => Promise.resolve([{ taskId: 'T-other', status: 'accepted' }]),
      }),
    );
    expect(ev.accepted).toBe(false);
  });

  it('FAIL-CLOSED: no active task → accepted:false (never auto-ship)', async () => {
    const ev = await deployEvidenceForSession(
      's',
      deps({
        activeTaskId: () => Promise.resolve(null),
        acceptance: () => Promise.resolve([{ taskId: 'T2.8', status: 'accepted' }]),
      }),
    );
    expect(ev.accepted).toBe(false);
  });

  it('FAIL-CLOSED: a throwing acceptance read → accepted:false', async () => {
    const ev = await deployEvidenceForSession(
      's',
      deps({ acceptance: () => Promise.reject(new Error('boom')) }),
    );
    expect(ev.accepted).toBe(false);
  });

  // REVERSIBLE-DEPLOY — auto-advance the accept decision; fail-closed on unknown/absent.
  it('reversible: false → reversible:false (irreversible; human gate holds)', async () => {
    const ev = await deployEvidenceForSession(
      's',
      deps({ reversible: () => Promise.resolve(false) }),
    );
    expect(ev.reversible).toBe(false);
  });

  it('reversible: true → reversible:true (auto-ship; no human gate needed)', async () => {
    const ev = await deployEvidenceForSession(
      's',
      deps({ reversible: () => Promise.resolve(true) }),
    );
    expect(ev.reversible).toBe(true);
  });

  it('FAIL-CLOSED: reversible reader throws → reversible:false (unknown = irreversible = human gate)', async () => {
    const ev = await deployEvidenceForSession(
      's',
      deps({ reversible: () => Promise.reject(new Error('boom')) }),
    );
    expect(ev.reversible).toBe(false);
  });
});
