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
    // skill_router + skill_prefilter were a DEAD cluster (routeSkills/prefilterSkills unused) → deleted, now MET.
    expect(byId['R-DELETE-SKILL-ROUTER']).toBe('met'); // module deleted
    expect(byId['R-DELETE-SKILL-PREFILTER']).toBe('met'); // module deleted
    // drift_response is NOT a deletion target — the per-pack-configurable drift system is the v2 design (restored
    // 2026-06-29; R-DELETE-DRIFT-RESPONSE removed from the manifest). 4 seeds remain.
    expect(byId['R-DELETE-DRIFT-RESPONSE']).toBeUndefined(); // requirement removed (config drift kept)
    expect(a.results.length).toBe(4);
  }, 30_000);
});
