#!/usr/bin/env node
/**
 * CFD.1 — report-only coverage runner (CI step). Prints the requirement coverage over the live tree and exits
 * 0: the seed gaps are expected-unmet (Track 1 closes them); the BLOCKING gate is a later track. Spec:
 * loop/docs/tasks/T-v2-coverage-foundation.md.
 */
import { runCoverageReport } from '../src/runtime/coverage/run.js';

const rep = runCoverageReport(process.cwd());
for (const r of rep.results) {
  process.stdout.write(
    `${r.status === 'met' ? '✓' : '✗'} ${r.id}${r.reason ? ` — ${r.reason}` : ''}\n`,
  );
}
const unmet = rep.results.filter((r) => r.status === 'unmet').length;
process.stdout.write(
  `\n${String(unmet)} unmet / ${String(rep.results.length)} requirements; ` +
    `${String(rep.orphans.length)} gated exports without a requirement (report-only — not a gate yet).\n`,
);
process.exit(0); // report-only
