/**
 * CFD.1 — the PURE, deterministic coverage checker. No I/O, no LLM, no subprocess: same input → same output.
 *
 * For each requirement it computes met|unmet via its assert kind. The PROOF-TEST is the uniform AUTHORITY for
 * the non-`absent` kinds (principle 1 / SPIKE-1): static reachability + ctx-key presence are ADVISORY
 * pre-filters only — recorded in the reason, NEVER a veto on a passing proof. `absent` is the negative
 * requirement (the symbol/module is gone). The orphan join surfaces gated symbols with no requirement.
 *
 * All inputs arrive via the injected `CodeIndex` (built once by `index_build.ts`, the only I/O). Report-only
 * in Slice 1 — the caller decides whether to fail CI (today: no).
 *
 * Spec: loop/docs/tasks/T-v2-coverage-foundation.md.
 */
import type { Assert, Requirement } from './schema.js';

export interface CodeIndex {
  exports: { name: string; file: string }[]; // exact exported/declared identifiers + their file
  modules: string[]; // module specifiers (basename without ext) — e.g. 'skill_router'
  bindings: Record<string, string[]>; // builder fn name → dotted ctx keys it sets
  tests: Record<string, { activeCount: number }>; // test path → count of non-skipped it()/test()
  importGraph: { reaches(from: string[], symbol: string): boolean };
}

export interface CheckOpts {
  gatedPrefixes: string[]; // ['src/', 'packs/'] — PROTECTED_PREFIXES minus test/
  allowlist?: string[]; // known un-requirement'd symbols (explicit exceptions)
  index: CodeIndex; // injected pure inputs — NO I/O inside checkCoverage
}

export interface ReqResult {
  id: string;
  status: 'met' | 'unmet';
  reason: string;
}
export interface CoverageReport {
  results: ReqResult[];
  orphans: string[]; // gated symbols with no requirement — report-only in Slice 1
}

const met = (r: Requirement, reason = ''): ReqResult => ({ id: r.id, status: 'met', reason });
const unmet = (r: Requirement, reason: string): ReqResult => ({
  id: r.id,
  status: 'unmet',
  reason,
});
const gated = (file: string, o: CheckOpts): boolean =>
  o.gatedPrefixes.some((p) => file.startsWith(p));

export function checkCoverage(reqs: Requirement[], opts: CheckOpts): CoverageReport {
  const results = reqs.map((r): ReqResult => {
    switch (r.assert.kind) {
      case 'absent':
        return symbolPresent(r.assert.symbol, opts) ? unmet(r, 'symbol still present') : met(r);
      case 'proof':
        return testExistsAndActive(r.assert.test, opts)
          ? met(r)
          : unmet(r, 'proof-test absent/failing');
      case 'reachable':
      case 'binding': {
        // PROOF-TEST IS THE AUTHORITY; the static check is an advisory pre-filter only (never a veto).
        const proofOk = r.proof !== undefined && testExistsAndActive(r.proof, opts);
        const staticHint =
          r.assert.kind === 'reachable'
            ? opts.index.importGraph.reaches(r.assert.from, r.assert.symbol)
            : ctxKeyBound(r.assert.ctx_key, r.assert.in, opts);
        if (!proofOk) return unmet(r, 'proof-test absent/failing');
        return met(
          r,
          staticHint
            ? ''
            : 'proof passes; static pre-filter negative (likely dynamic dispatch) — advisory',
        );
      }
    }
  });
  return { results, orphans: gatedSymbolsWithoutRequirement(reqs, opts) };
}

/** The symbol/module/key/test an assert targets (for the orphan join). */
function assertSubject(a: Assert): string {
  switch (a.kind) {
    case 'reachable':
    case 'absent':
      return a.symbol;
    case 'binding':
      return a.ctx_key;
    case 'proof':
      return a.test;
  }
}

// EXACT-token: a whole exported identifier OR a module specifier — never a substring ('escalate' !== 'escalateLap').
function symbolPresent(symbol: string, o: CheckOpts): boolean {
  return (
    o.index.exports.some((e) => e.name === symbol && gated(e.file, o)) ||
    o.index.modules.includes(symbol)
  );
}
function ctxKeyBound(ctxKey: string, builder: string, o: CheckOpts): boolean {
  return (o.index.bindings[builder] ?? []).includes(ctxKey);
}
function testExistsAndActive(test: string, o: CheckOpts): boolean {
  return (o.index.tests[test]?.activeCount ?? 0) > 0; // exists + >=1 non-skipped (in-CI PASS is the CI run itself)
}
function gatedSymbolsWithoutRequirement(reqs: Requirement[], o: CheckOpts): string[] {
  const claimed = new Set(reqs.map((r) => assertSubject(r.assert)));
  const allow = new Set(o.allowlist ?? []);
  return o.index.exports
    .filter((e) => gated(e.file, o) && !claimed.has(e.name) && !allow.has(e.name))
    .map((e) => e.name);
}
