import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { verifyLiveScopeEvidence, type LiveScopeEvidence } from './fullstack-scope-live.js';

function evidence(harness: LiveScopeEvidence['harness']): LiveScopeEvidence {
  const nonce = 'n-1';
  const allowedPath = `/project/docs/research/${harness}-pre-research-live.md`;
  const deniedPath = '/project/src/denied-live.ts';
  const bytes = Buffer.from(`scope-live-${harness}-${nonce}\n`, 'utf8');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const itemId = 'wg-123456789abc';
  const base: LiveScopeEvidence = {
    harness,
    hostVersion: 'test-1.0.0',
    trust: harness === 'codex' ? 'ordinary' : 'not-applicable',
    nonce,
    allowedPath,
    deniedPath,
    artifactBefore: 'absent',
    artifactBytesBase64: bytes.toString('base64'),
    deniedPathAbsent: true,
    toolEvents: [
      {
        id: 'allowed-1',
        phase: 'pre',
        tool: 'Write',
        path: allowedPath,
        decision: 'allow',
        attemptedContentSha256: hash,
      },
      {
        id: 'allowed-1',
        phase: 'post',
        tool: 'Write',
        path: allowedPath,
        decision: 'completed',
      },
      {
        id: 'denied-1',
        phase: 'pre',
        tool: 'Write',
        path: deniedPath,
        decision: 'deny',
      },
    ],
    commandEvents: [],
    receipts: [],
    issueIdsBefore: [],
    issueIdsAfter: [itemId],
    itemId,
    activeTaskId: itemId,
    entryCheckpointStage: 'scope',
  };
  if (harness !== 'pi') return base;
  return {
    ...base,
    commandEvents: [
      {
        id: 'scope-done-1',
        name: 'scope-done',
        args: `${itemId} ${allowedPath}`,
        outcome: 'completed',
      },
    ],
    receipts: [
      { actionId: 'receipt-1', wgId: itemId, artifactPath: allowedPath, artifactSha256: hash },
    ],
    handoff: {
      invokedVia: 'pi-native-scope-done',
      commandEventId: 'scope-done-1',
      approvedArtifactSha256: hash,
      receiptActionId: 'receipt-1',
      checkpointStage: 'scope_write',
      loopStatus: 'running',
      underlyingStartCount: 1,
    },
  };
}

describe('verifyLiveScopeEvidence', () => {
  it.each(['claude', 'codex', 'pi'] as const)('accepts fully correlated %s evidence', (harness) => {
    expect(() => verifyLiveScopeEvidence(evidence(harness))).not.toThrow();
  });

  it('rejects asserted success without correlated completed write events', () => {
    const invalid = { ...evidence('claude'), toolEvents: [] };
    expect(() => verifyLiveScopeEvidence(invalid)).toThrow(/not distinctly correlated/u);
  });

  it('rejects wrong bytes, a materialized denied path, and non-ordinary Codex trust', () => {
    const wrongBytes = {
      ...evidence('claude'),
      artifactBytesBase64: Buffer.from('wrong').toString('base64'),
    };
    expect(() => verifyLiveScopeEvidence(wrongBytes)).toThrow(/bytes differ/u);
    expect(() =>
      verifyLiveScopeEvidence({ ...evidence('claude'), deniedPathAbsent: false }),
    ).toThrow(/denied source path exists/u);
    expect(() =>
      verifyLiveScopeEvidence({ ...evidence('codex'), trust: 'not-applicable' }),
    ).toThrow(/ordinary persisted/u);
  });

  it('requires Pi command/receipt/hash/checkpoint/start correlation', () => {
    const invalid = { ...evidence('pi'), receipts: [] };
    expect(() => verifyLiveScopeEvidence(invalid)).toThrow(/handoff evidence is incomplete/u);
  });
});
