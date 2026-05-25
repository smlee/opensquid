/**
 * Report generator for the G.13 end-to-end drift-prevention test pass.
 *
 * Called from `afterAll` in `drift-prevention.e2e.test.ts`. Writes a
 * markdown report to `test/e2e/e2e-drift-prevention-report.md` with
 * per-scenario pass/fail + timing + any error context. Mirrors the file
 * name the G.13 spec calls out (acceptance criteria line 1941, and the
 * verification command on line 1964 cats this exact path).
 *
 * Not committed to git. Generated fresh on every E2E run. The .gitignore
 * entry lives alongside this file (path `test/e2e/e2e-drift-prevention-
 * report.md`) so accidental `git add` doesn't sneak it into a commit.
 *
 * Pure: no fs/spawn beyond the single writeFile at flush time. Callers
 * record scenarios via `recordScenario`, then call `writeReport` once.
 *
 * Imports from: node:fs/promises.
 * Imported by: test/e2e/drift-prevention.e2e.test.ts (afterAll path).
 */

import { writeFile } from 'node:fs/promises';

export interface ScenarioRecord {
  /** Spec label like "G.4" — used as the row key in the markdown table. */
  id: string;
  /** Human-readable summary of the scenario. */
  description: string;
  /** Pass / fail / skipped. */
  status: 'pass' | 'fail' | 'skip';
  /** Wall-clock duration in ms. */
  durationMs: number;
  /** Free-form notes — error message on fail, decision rationale on skip. */
  notes: string;
}

export class DriftPreventionReport {
  private records: ScenarioRecord[] = [];
  private startedAt = Date.now();

  recordScenario(rec: ScenarioRecord): void {
    this.records.push(rec);
  }

  /** Build the markdown body. Public for tests; called by writeReport. */
  renderMarkdown(): string {
    const totalMs = Date.now() - this.startedAt;
    const totals = {
      pass: this.records.filter((r) => r.status === 'pass').length,
      fail: this.records.filter((r) => r.status === 'fail').length,
      skip: this.records.filter((r) => r.status === 'skip').length,
    };
    const header = [
      `# G.13 — End-to-end drift-prevention report`,
      ``,
      `Generated: ${new Date().toISOString()}`,
      `Total runtime: ${(totalMs / 1000).toFixed(2)}s`,
      `Result: ${String(totals.pass)} pass / ${String(totals.fail)} fail / ${String(totals.skip)} skip`,
      ``,
      `## Per-scenario`,
      ``,
      `| Scenario | Status | Duration | Notes |`,
      `| --- | --- | --- | --- |`,
    ];
    const rows = this.records.map((r) => {
      const status = r.status === 'pass' ? 'PASS' : r.status === 'fail' ? 'FAIL' : 'SKIP';
      const notes = r.notes.replace(/\|/g, '\\|').replace(/\n/g, ' / ');
      return `| ${r.id} ${r.description} | ${status} | ${String(r.durationMs)}ms | ${notes} |`;
    });
    return header.concat(rows, [``]).join('\n');
  }

  async writeReport(path: string): Promise<void> {
    await writeFile(path, this.renderMarkdown());
  }
}
