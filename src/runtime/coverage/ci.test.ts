/** CFD.1 — report-only coverage over the LIVE tree: seeds detected unmet, deterministically. */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { runCoverageReport } from './run.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('coverage report-only over the live tree (CFD.1)', () => {
  it('detects each seeded requirement as unmet, deterministically (report-only, no LLM/subprocess)', () => {
    const a = runCoverageReport(REPO);
    const b = runCoverageReport(REPO);
    expect(a.results).toEqual(b.results); // byte-identical re-run

    const byId = Object.fromEntries(a.results.map((r) => [r.id, r.status]));
    // The five seeds are all CURRENTLY-UNMET gaps (Track 1 closes them):
    expect(byId['R-SKILLS-PER-STATE']).toBe('unmet'); // proof-test absent
    expect(byId['R-AUDIT-CTX']).toBe('unmet'); // proof-test absent
    expect(byId['R-DELETE-SKILL-ROUTER']).toBe('unmet'); // module still present
    expect(byId['R-DELETE-SKILL-PREFILTER']).toBe('unmet');
    expect(byId['R-DELETE-DRIFT-RESPONSE']).toBe('unmet');
    expect(a.results.length).toBe(5);
  }, 30_000);
});
