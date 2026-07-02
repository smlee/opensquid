/**
 * T2.6 — the AUTHOR gate's pure coverage wrapper (zero LLM, zero I/O).
 *
 * Wraps the shipped, deterministic `checkCoverage` (`coverage/check.ts:49`) into the two facets the
 * `fullstack-flow` AUTHOR gate predicates on:
 *   manifestComplete = `report.orphans.length === 0` — no gated export lacks a covering requirement.
 *   realCode         = `report.results.every(r => r.met)` — every requirement is MET, where `met` for the
 *                      reachable/binding kinds REQUIRES the proof-test to pass (`check.ts:54-73`). A stub with
 *                      no passing proof fails → `realCode:false` (kills "declared ≠ wired").
 *
 * The two facets are DISTINCT fields (orphans vs results), so an orphan and a failing proof-test are
 * independently observable. Same input → same output (the underlying checker is pure).
 *
 * Spec: docs/tasks/T-v2-track2-discipline.md T2.6 ("Key code shapes").
 */
import { checkCoverage } from '../coverage/check.js';

export interface AuthorEvidence {
  manifestComplete: boolean;
  realCode: boolean;
}

/** PURE: run the coverage checker and project the two AUTHOR facets. */
export function authorEvidence(
  reqs: Parameters<typeof checkCoverage>[0],
  opts: Parameters<typeof checkCoverage>[1],
): AuthorEvidence {
  const r = checkCoverage(reqs, opts);
  return {
    manifestComplete: r.orphans.length === 0,
    realCode: r.results.every((x) => x.status === 'met'),
  };
}
