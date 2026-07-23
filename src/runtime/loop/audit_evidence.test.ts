import { describe, expect, it } from 'vitest';

import { MAX_SUBAGENT_RESULT_BYTES } from '../subagents/types.js';

import {
  aggregateAuditLenses,
  auditEvidenceMatchesPolicy,
  auditEvidenceMatchesPolicyForDiagnostics,
  auditVerdictMatchesPass,
  MAX_AUDIT_AGGREGATE_EVIDENCE_BYTES,
  deriveAuditEvidenceVerdict,
  parseAuditEvidenceEntry,
} from './audit_evidence.js';

const HASH = 'f'.repeat(64);
const lens = (id: string, output = 'VERDICT: GUESS_FREE') => ({
  id,
  promptHash: id.padEnd(64, 'a').slice(0, 64),
  output,
});

describe('audit evidence contract', () => {
  it('rejects malformed/reduced complete evidence instead of filtering it', () => {
    expect(
      parseAuditEvidenceEntry({
        hash: HASH,
        complete: true,
        passVerdict: 'GUESS_FREE',
        failVerdict: 'UNRESOLVED',
        lenses: [],
      }),
    ).toBeNull();
    expect(
      parseAuditEvidenceEntry({
        hash: HASH,
        complete: true,
        passVerdict: 'GUESS_FREE',
        failVerdict: 'UNRESOLVED',
        lenses: [lens('a'), { ...lens('b'), output: 42 }],
      }),
    ).toBeNull();
    expect(
      parseAuditEvidenceEntry({
        hash: HASH,
        complete: true,
        passVerdict: 'GUESS_FREE',
        failVerdict: 'UNRESOLVED',
        lenses: [lens('a'), lens('a')],
      }),
    ).toBeNull();
  });

  it('rejects contradictory and oversized persisted variants', () => {
    expect(
      parseAuditEvidenceEntry({
        hash: HASH,
        verdict: 'VERDICT: GUESS_FREE',
        complete: true,
        passVerdict: 'GUESS_FREE',
        failVerdict: 'UNRESOLVED',
        lenses: [lens('a'), lens('b')],
      }),
    ).toBeNull();
    expect(
      parseAuditEvidenceEntry({
        hash: HASH,
        complete: true,
        passVerdict: 'GUESS_FREE',
        failVerdict: 'UNRESOLVED',
        lenses: [lens('a'), lens('b')],
        failures: [{ id: 'c', error: 'contradiction' }],
      }),
    ).toBeNull();
    expect(
      parseAuditEvidenceEntry({
        hash: HASH,
        complete: true,
        passVerdict: 'GUESS_FREE',
        failVerdict: 'UNRESOLVED',
        lenses: [lens('a', '🔥'.repeat(MAX_SUBAGENT_RESULT_BYTES)), lens('b')],
      }),
    ).toBeNull();
    const quarter = Math.floor(MAX_AUDIT_AGGREGATE_EVIDENCE_BYTES / 4) + 1;
    expect(
      parseAuditEvidenceEntry({
        hash: HASH,
        complete: true,
        passVerdict: 'GUESS_FREE',
        failVerdict: 'UNRESOLVED',
        lenses: ['a', 'b', 'c', 'd'].map((id) =>
          lens(id, `VERDICT: UNRESOLVED\n${'x'.repeat(quarter)}`),
        ),
      }),
    ).toBeNull();
  });

  it('never lets invalid verdict policy, count, or oversized evidence pass/escape its bound', () => {
    expect(aggregateAuditLenses([lens('a'), lens('b')], 'GUESS_FREE', 'GUESS_FREE')).toMatch(
      /^VERDICT: UNRESOLVED/u,
    );
    expect(aggregateAuditLenses([lens('a'), lens('b')], 'bad', 'UNRESOLVED')).toMatch(
      /^VERDICT: UNRESOLVED/u,
    );
    expect(aggregateAuditLenses([lens('a'), lens('a')], 'GUESS_FREE', 'UNRESOLVED')).toMatch(
      /^VERDICT: UNRESOLVED/u,
    );
    expect(aggregateAuditLenses([lens('INVALID!'), lens('b')], 'GUESS_FREE', 'UNRESOLVED')).toMatch(
      /^VERDICT: UNRESOLVED/u,
    );
    expect(auditVerdictMatchesPass('VERDICT: GUESS_FREE', 'UNRESOLVED')).toBe(false);
    expect(auditVerdictMatchesPass('VERDICT: UNRESOLVED', 'UNRESOLVED')).toBe(true);
    expect(aggregateAuditLenses([], 'GUESS_FREE', 'UNRESOLVED')).toBe(
      'VERDICT: UNRESOLVED\n- [audit] invalid lens evidence count (0 completed; expected 2-4)',
    );
    const overDeclared = aggregateAuditLenses(
      ['a', 'b', 'c', 'd', 'e'].map((id) => lens(id)),
      'GUESS_FREE',
      'UNRESOLVED',
    );
    expect(overDeclared).toMatch(/^VERDICT: UNRESOLVED/u);
    expect(overDeclared).toContain('[a] PASS');
    expect(overDeclared).toContain('[e] PASS');
    const oversized = aggregateAuditLenses(
      ['a', 'b', 'c', 'd'].map((id) =>
        lens(id, `VERDICT: UNRESOLVED\n${'x'.repeat(MAX_SUBAGENT_RESULT_BYTES)}`),
      ),
      'GUESS_FREE',
      'UNRESOLVED',
    );
    expect(Buffer.byteLength(oversized, 'utf8')).toBeLessThanOrEqual(MAX_SUBAGENT_RESULT_BYTES);
    expect(oversized).toContain('[d] audit output exceeded aggregate evidence bound');
    const hostileIds = aggregateAuditLenses(
      [lens('x'.repeat(100_000), 'VERDICT: UNRESOLVED'), lens('b', 'VERDICT: UNRESOLVED')],
      'GUESS_FREE',
      'UNRESOLVED',
    );
    expect(Buffer.byteLength(hostileIds, 'utf8')).toBeLessThan(MAX_SUBAGENT_RESULT_BYTES);
    expect(hostileIds).toContain('[lens-1]');
  });

  it('derives and authorizes only exact complete policy evidence', () => {
    const complete = parseAuditEvidenceEntry({
      hash: HASH,
      complete: true,
      passVerdict: 'GUESS_FREE',
      failVerdict: 'UNRESOLVED',
      lenses: [lens('a'), lens('b')],
    });
    expect(complete).not.toBeNull();
    expect(deriveAuditEvidenceVerdict(complete!)).toMatch(/^VERDICT: GUESS_FREE/u);
    expect(
      auditEvidenceMatchesPolicy(complete!, {
        hash: HASH,
        passVerdict: 'GUESS_FREE',
        failVerdict: 'UNRESOLVED',
        lenses: [
          { id: 'a', promptHash: lens('a').promptHash },
          { id: 'b', promptHash: lens('b').promptHash },
        ],
      }),
    ).toBe(true);
    expect(
      auditEvidenceMatchesPolicy(complete!, {
        hash: HASH,
        passVerdict: 'GUESS_FREE',
        failVerdict: 'UNRESOLVED',
        lenses: [{ id: 'a', promptHash: lens('a').promptHash }],
      }),
    ).toBe(false);

    const partial = parseAuditEvidenceEntry({
      hash: HASH,
      complete: false,
      passVerdict: 'GUESS_FREE',
      failVerdict: 'UNRESOLVED',
      lenses: [lens('a')],
      failures: [{ id: 'b', error: 'timed out' }],
    });
    const policy = {
      hash: HASH,
      passVerdict: 'GUESS_FREE',
      failVerdict: 'UNRESOLVED',
      lenses: [
        { id: 'a', promptHash: lens('a').promptHash },
        { id: 'b', promptHash: lens('b').promptHash },
      ],
    };
    expect(auditEvidenceMatchesPolicy(partial!, policy)).toBe(false);
    expect(auditEvidenceMatchesPolicyForDiagnostics(partial!, policy)).toBe(true);
    expect(deriveAuditEvidenceVerdict(partial!)).toContain('[a] PASS');
    expect(deriveAuditEvidenceVerdict(partial!)).toContain('[b] timed out');
  });
});
