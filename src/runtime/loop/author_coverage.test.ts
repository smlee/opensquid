/** T2.6 — authorEvidence: the pure AUTHOR facets (manifestComplete ∧ realCode) over checkCoverage. */
import { describe, expect, it } from 'vitest';

import type { CodeIndex } from '../coverage/check.js';
import { Requirement } from '../coverage/schema.js';
import { authorEvidence } from './author_coverage.js';

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

// A `proof`-kind requirement whose proof-test is its own `assert.test` — the simplest met/unmet lever.
const proofReq = (id: string, test: string): Requirement =>
  req({ id, intent: 'x', assert: { kind: 'proof', test } });

describe('authorEvidence (T2.6)', () => {
  it('all requirements met + zero orphans → both true', () => {
    const reqs = [proofReq('R-A', 'src/a.test.ts'), proofReq('R-B', 'src/b.test.ts')];
    const ev = authorEvidence(
      reqs,
      opts(
        idx({
          // both proofs active → both met; the only gated exports ARE the claimed test subjects → no orphan
          tests: { 'src/a.test.ts': { activeCount: 1 }, 'src/b.test.ts': { activeCount: 1 } },
        }),
      ),
    );
    expect(ev).toEqual({ manifestComplete: true, realCode: true });
  });

  it('a gated export with no requirement → an orphan → manifestComplete:false (realCode untouched)', () => {
    const reqs = [proofReq('R-A', 'src/a.test.ts')];
    const ev = authorEvidence(
      reqs,
      opts(
        idx({
          tests: { 'src/a.test.ts': { activeCount: 1 } }, // R-A met → realCode true
          exports: [{ name: 'orphanSym', file: 'src/o.ts' }], // gated export with no requirement → orphan
        }),
      ),
    );
    expect(ev.manifestComplete).toBe(false); // orphans.length > 0
    expect(ev.realCode).toBe(true); // results still all met — the two facets are DISTINCT fields
  });

  it('a requirement whose proof-test is ABSENT → realCode:false (a stub fails — declared ≠ wired)', () => {
    const reqs = [proofReq('R-STUB', 'src/stub.test.ts')];
    const ev = authorEvidence(reqs, opts(idx({}))); // no tests recorded → proof absent → unmet
    expect(ev.realCode).toBe(false);
    expect(ev.manifestComplete).toBe(true); // no gated exports → no orphans (distinct from realCode)
  });

  it('a reachable requirement whose proof-test is failing/absent → realCode:false (proof is the authority)', () => {
    const reqs = [
      req({
        id: 'R-REACH',
        intent: 'x',
        assert: { kind: 'reachable', symbol: 'onStateEntry', from: ['pre-tool-use'] },
        proof: 'src/r.test.ts',
      }),
    ];
    // statically reachable, but the proof-test is absent → check.ts:54-73 → unmet → realCode false
    const ev = authorEvidence(reqs, opts(idx({ importGraph: { reaches: () => true } })));
    expect(ev.realCode).toBe(false);
  });

  it('determinism: same input → same output', () => {
    const reqs = [proofReq('R-A', 'src/a.test.ts')];
    const o = opts(idx({ tests: { 'src/a.test.ts': { activeCount: 1 } } }));
    expect(authorEvidence(reqs, o)).toEqual(authorEvidence(reqs, o));
  });
});
