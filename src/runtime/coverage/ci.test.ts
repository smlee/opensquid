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
    // wg-fecabb8ff29f (auto-trigger loop on scope-exit) — 3 new behavioral exports, each MET via its passing
    // proof-test (loop_autospawn.test.ts); the data-shape siblings are allowlisted (no orphan drift).
    expect(byId['R-LOOP-AUTOSPAWN']).toBe('met'); // ensureLoopRunning (idempotent/single-flight/fail-open)
    expect(byId['R-LOOP-STATUS']).toBe('met'); // loopStatus (project-local pidfile liveness)
    expect(byId['R-LOOP-START']).toBe('met'); // startLoop (detached background spawn)
    // T-opensquid-release-flow (REL.1..REL.4) — 14 new behavioral exports, each MET via its element proof-test;
    // the data-shape siblings (ParsedCommit/BumpLevel/NpmView/ReleaseDeps) are allowlisted (no orphan drift).
    for (const id of [
      'R-RELEASE-MERGE',
      'R-RELEASE-TAG',
      'R-RELEASE-READ-VERSION',
      'R-RELEASE-WRITE-VERSION',
      'R-RELEASE-LAST-TAG',
      'R-RELEASE-SUBJECTS',
      'R-RELEASE-PUBLISHED',
      'R-RELEASE-PARSE',
      'R-RELEASE-VALIDATE-MSG',
      'R-RELEASE-BUMP-LEVEL',
      'R-RELEASE-NEXT-VERSION',
      'R-RELEASE-COMMIT-MSG-GATE',
      'R-RELEASE-RUN',
      'R-RELEASE-REGISTER',
    ]) {
      expect(byId[id]).toBe('met');
    }
    // T-loop-monitoring-pushstream (wg-61db3ededf19, LMP.1..5) — 9 new behavioral exports of the PUSH/STREAM
    // monitor feed, each MET via its element proof-test; the data-shape siblings (MonitorEvent/NewMonitorEvent/
    // MonitorEventKind/PhaseLifecycle/LoopFoldState/ProcedureLintResult) are allowlisted (no orphan drift).
    for (const id of [
      'R-MONITOR-APPEND',
      'R-MONITOR-TAIL',
      'R-MONITOR-EMIT',
      'R-MONITOR-FOLD',
      'R-MONITOR-FOLD-LATEST',
      'R-MONITOR-SUBSCRIBE',
      'R-MONITOR-LIVE-ITEMS',
      'R-MONITOR-AGE',
      'R-MONITOR-PHASE-LINT',
    ]) {
      expect(byId[id]).toBe('met');
    }
    expect(a.results.length).toBe(47); // 4 original + 7 V2-ENF.2 + 2 PLS.1 + 3 loop-autospawn + 14 release + 8 WGL + 9 loop-monitoring
  }, 30_000);
});
