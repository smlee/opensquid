/** CFD.1 — checkCoverage: proof-as-authority, exact-token absent, orphan join. */
import { describe, expect, it } from 'vitest';

import { checkCoverage, type CodeIndex } from './check.js';
import { Requirement } from './schema.js';

const idx = (o: Partial<CodeIndex>): CodeIndex => ({
  exports: [],
  modules: [],
  bindings: {},
  tests: {},
  importGraph: { reaches: () => false },
  ...o,
});
const req = (x: unknown): Requirement => Requirement.parse(x);
const opts = (index: CodeIndex) => ({ gatedPrefixes: ['src/', 'packs/'], index });

describe('checkCoverage (CFD.1)', () => {
  it('absent: exact-token — `escalate` is NOT satisfied-present by `escalateLap`', () => {
    const r = req({
      id: 'R-DELETE-ESCALATE',
      intent: 'gone',
      assert: { kind: 'absent', symbol: 'escalate' },
    });
    const onlyLap = checkCoverage(
      [r],
      opts(idx({ exports: [{ name: 'escalateLap', file: 'src/a.ts' }] })),
    );
    expect(onlyLap.results[0]).toMatchObject({ status: 'met' }); // escalate itself absent → met (no substring hit)
    const present = checkCoverage([r], opts(idx({ modules: ['escalate'] })));
    expect(present.results[0]?.status).toBe('unmet');
  });

  it('reachable: PROOF is authority — proof-absent → unmet even when statically reachable', () => {
    const r = req({
      id: 'R-SKILLS-PER-STATE',
      intent: 'x',
      assert: { kind: 'reachable', symbol: 'onStateEntry', from: ['pre-tool-use'] },
      proof: 'src/x.live.test.ts',
    });
    const reachNoProof = checkCoverage([r], opts(idx({ importGraph: { reaches: () => true } })));
    expect(reachNoProof.results[0]?.status).toBe('unmet'); // reach=true but proof absent → unmet
    const proofNoReach = checkCoverage(
      [r],
      opts(
        idx({
          tests: { 'src/x.live.test.ts': { activeCount: 1 } },
          importGraph: { reaches: () => false },
        }),
      ),
    );
    expect(proofNoReach.results[0]?.status).toBe('met'); // proof passes, static reach false → met (advisory)
    expect(proofNoReach.results[0]?.reason).toMatch(/advisory/);
  });

  it('binding: PROOF is authority — static ctx-key presence alone never satisfies', () => {
    const r = req({
      id: 'R-AUDIT-CTX',
      intent: 'x',
      assert: { kind: 'binding', ctx_key: 'verdict.guess', in: 'buildGuardCtx' },
      proof: 'src/b.test.ts',
    });
    const keyNoProof = checkCoverage(
      [r],
      opts(idx({ bindings: { buildGuardCtx: ['verdict.guess'] } })),
    );
    expect(keyNoProof.results[0]?.status).toBe('unmet');
    const withProof = checkCoverage(
      [r],
      opts(
        idx({
          tests: { 'src/b.test.ts': { activeCount: 1 } },
          bindings: { buildGuardCtx: ['verdict.guess'] },
        }),
      ),
    );
    expect(withProof.results[0]?.status).toBe('met');
  });

  it('proof: skipped-only test does not count (activeCount 0 → unmet)', () => {
    const r = req({ id: 'R-P', intent: 'x', assert: { kind: 'proof', test: 'src/p.test.ts' } });
    expect(
      checkCoverage([r], opts(idx({ tests: { 'src/p.test.ts': { activeCount: 0 } } }))).results[0]
        ?.status,
    ).toBe('unmet');
    expect(
      checkCoverage([r], opts(idx({ tests: { 'src/p.test.ts': { activeCount: 2 } } }))).results[0]
        ?.status,
    ).toBe('met');
  });

  it('orphan: a gated export with no requirement is reported (report-only)', () => {
    const r = req({ id: 'R-DELETE-X', intent: 'gone', assert: { kind: 'absent', symbol: 'gone' } });
    const rep = checkCoverage(
      [r],
      opts(idx({ exports: [{ name: 'orphanSym', file: 'src/o.ts' }] })),
    );
    expect(rep.orphans).toContain('orphanSym');
  });
});
