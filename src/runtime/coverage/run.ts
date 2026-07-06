/**
 * CFD.1 — the report-only coverage runner. Reads the seed manifest embedded in the git-tracked
 * `docs/ARCHITECTURE.md`, builds the CodeIndex over the gated tree, and returns the coverage report. Report-only
 * in Slice 1 — the caller never fails CI on the (expected-unmet) seed gaps; the blocking gate is a later track.
 *
 * Spec: loop/docs/tasks/T-v2-coverage-foundation.md.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { extractRequirements } from './schema.js';
import { buildCodeIndex } from './index_build.js';
import { checkCoverage, type CoverageReport } from './check.js';

export const GATED_PREFIXES = ['src/', 'packs/']; // PROTECTED_PREFIXES minus test/
export const MANIFEST_FILE = 'docs/ARCHITECTURE.md';
// The grandfathered coverage BASELINE — pre-existing gated exports exempt from a covering requirement, so the
// AUTHOR gate is a forward RATCHET (new/changed exports need coverage; legacy is baselined) rather than an
// unsatisfiable "cover all ~2000 exports now" (the report-only seed gaps the manifest never covered). Regenerate
// deliberately when adopting coverage deeper.
export const ALLOWLIST_FILE = 'docs/coverage-allowlist.txt';

/** Read the baseline allowlist (one symbol per line; `#`-comments + blanks ignored). Absent file → []. */
export function readAllowlist(repoRoot: string): string[] {
  try {
    return readFileSync(join(repoRoot, ALLOWLIST_FILE), 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));
  } catch {
    return [];
  }
}

export function runCoverageReport(repoRoot: string): CoverageReport {
  const reqs = extractRequirements(
    MANIFEST_FILE,
    readFileSync(join(repoRoot, MANIFEST_FILE), 'utf8'),
  );
  const index = buildCodeIndex(repoRoot, GATED_PREFIXES);
  return checkCoverage(reqs, {
    gatedPrefixes: GATED_PREFIXES,
    index,
    allowlist: readAllowlist(repoRoot),
  });
}
