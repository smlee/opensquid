/** CFD.1 — report-only coverage over the LIVE tree: seeds detected unmet, deterministically. */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { runCoverageReport } from './run.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('coverage report-only over the live tree (CFD.1)', () => {
  it('reports each seeded requirement status deterministically (report-only, no LLM/subprocess)', () => {
    const a = runCoverageReport(REPO);
    const b = runCoverageReport(REPO);
    expect(a.results).toEqual(b.results); // byte-identical re-run

    const byId = Object.fromEntries(a.results.map((r) => [r.id, r.status]));
    // Track 1 (T-v2-track1-finish) closed the two non-deletion seeds — they are now MET via the live path:
    expect(byId['R-SKILLS-PER-STATE']).toBe('met'); // onStateEntry reachable from hooks + live proof present
    expect(byId['R-AUDIT-CTX']).toBe('met'); // verdict.guess bound in buildGuardCtx + proof present
    // The three deletion seeds remain UNMET (their modules are removed in Track 4; v1 stays the live fallback):
    expect(byId['R-DELETE-SKILL-ROUTER']).toBe('unmet'); // module still present
    expect(byId['R-DELETE-SKILL-PREFILTER']).toBe('unmet');
    expect(byId['R-DELETE-DRIFT-RESPONSE']).toBe('unmet');
    expect(a.results.length).toBe(5);
  }, 30_000);
});
