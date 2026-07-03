/**
 * #16 — the retention-sweep GATE WIRING (design: docs/reports/v2-scope-clarifications-2026-07-01.md:150).
 *
 * `session-end.ts` Part 2 hard-deletes retired AGENT memories older than the 30-day window
 * (`backend.sweepRetired`). Per #16 this destructive sweep is a TIMING/SAFETY-gated operation: it may
 * run ONLY when the #16 prune gate (`retentionPruneAllowed`) says the cwd project's work-graph cycle is
 * complete AND its git tree is clean. Before this seam existed the sweep ran UNCONDITIONALLY every
 * session-end, bypassing the gate — this module wires the gate to the sweep.
 *
 * The gate (`retentionPruneAllowed`) is itself FAIL-CLOSED: any error/uncertainty ⇒ `false` ⇒ skip. This
 * function does NOT swallow a gate throw (production's gate can't throw — it's internally fail-closed);
 * an injected/unexpected throw propagates to `session-end.ts`'s existing try/catch, which logs
 * "retention sweep skipped" and completes teardown (fail-OPEN on the hook). Skipping the sweep NEVER
 * deletes — the safe direction.
 *
 * INJECTABLE (`deps`): tests pass a pure gate + a fake clock; the default binds the shipped
 * `retentionPruneAllowed` + `Date.now`.
 * Imports from: ./session_end_prune_gate.js. Imported by: session-end.ts + session_end_retention.test.ts.
 */
import { retentionPruneAllowed } from './session_end_prune_gate.js';

/** RSW.1 (wg-9e4f4eb2a40f): demoted memory is hard-deleted after this quiet window. */
export const RETENTION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** The only backend surface this seam needs — the optional destructive sweep. */
export interface RetentionSweepBackend {
  sweepRetired?(cutoffIso: string): Promise<string[]>;
}

/** Injectable seams — tests stub the gate + clock; defaults bind the shipped gate + `Date.now`. */
export interface SweepGateDeps {
  /** The #16 prune gate: `true` iff the destructive sweep may run for `cwd` this session. */
  pruneAllowed?: (cwd: string) => Promise<boolean>;
  /** Clock (ms since epoch) for the retention cutoff — injectable for deterministic tests. */
  now?: () => number;
}

/**
 * Run the 30-day retention sweep for `backend` ONLY when the #16 prune gate allows it for `cwd`.
 * Returns the swept ids, or `[]` when the gate says skip (cycle incomplete / tree dirty / uncertain).
 * Does NOT catch a gate throw — the caller's try/catch preserves session-end fail-open (see file header).
 */
export async function sweepRetiredIfAllowed(
  backend: RetentionSweepBackend,
  cwd: string,
  deps: SweepGateDeps = {},
): Promise<string[]> {
  const pruneAllowed = deps.pruneAllowed ?? retentionPruneAllowed;
  if (!(await pruneAllowed(cwd))) return []; // gate says skip — never hard-delete when the cycle is in-flight/dirty
  const now = deps.now ?? Date.now;
  const cutoff = new Date(now() - RETENTION_WINDOW_MS).toISOString();
  return (await backend.sweepRetired?.(cutoff)) ?? [];
}
