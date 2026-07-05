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
    // 2026-06-29; R-DELETE-DRIFT-RESPONSE removed from the manifest).
    expect(byId['R-DELETE-DRIFT-RESPONSE']).toBeUndefined(); // requirement removed (config drift kept)
    // V2-ENF.2 (wg-0baaae4bcf2e) — mandatory-reporting added ONE covering requirement per scoped element
    // (reporting-model §7.1); each has a shipped module + proof test, so all resolve MET via the live path.
    expect(byId['R-REPORT-CHECKLIST']).toBe('met'); // report_checklist.ts (workgraph-is-the-checklist)
    expect(byId['R-REPORT-TEMPLATE']).toBe('met'); // report_template.ts (core-default + pack-override)
    expect(byId['R-REPORT-RESOLUTION']).toBe('met'); // report_resolution.ts (block-on-unresolved facet)
    expect(byId['R-REPORTS-DIR']).toBe('met'); // reports_dir.ts (<project>/.opensquid/reports/)
    expect(byId['R-HANDOFF-DEDUP']).toBe('met'); // handoff key-drift + double-send dedup
    expect(byId['R-FAILURE-REPORT']).toBe('met'); // failure_report.ts (§5.4b — report WHY on any fail)
    expect(byId['R-FOLLOW-REMINDER']).toBe('met'); // follow_reminder.ts (§5.4c — anti-drift nudge)
    expect(a.results.length).toBe(11); // 4 original seeds + 7 V2-ENF.2 covering requirements
  }, 30_000);
});
