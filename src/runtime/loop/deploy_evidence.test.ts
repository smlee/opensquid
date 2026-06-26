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
});
