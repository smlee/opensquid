/**
 * Plausibility probe for stale-prone session ids. Fresh hook-owned files are
 * normal activity signals. Long reviewer activity is projected from the same
 * canonical machine admission locks that own concurrency.
 */

import { stat } from 'node:fs/promises';

import { readAuditActivity } from '../audit_admission.js';
import { activeTaskFile, sessionStateFile } from '../paths.js';

/** Default freshness window: 30 minutes (`1_800_000` ms). */
export const DEFAULT_FRESH_MS = 1_800_000;

/** Resolve a positive env override, otherwise the default freshness window. */
export function FRESH_MS(): number {
  const raw = process.env.OPENSQUID_SESSION_FRESH_MS;
  if (raw === undefined || raw === '') return DEFAULT_FRESH_MS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_FRESH_MS;
}

export interface PlausibilityResult {
  plausible: boolean;
  newestMtimeMs: number | null;
  probedFiles: string[];
}

export interface PlausibilityOpts {
  nowMs?: () => number;
  freshMs?: number;
}

/** True iff a normal freshness signal or the canonical audit admission projection is active. */
export async function isSessionPlausible(
  sessionId: string,
  opts: PlausibilityOpts = {},
): Promise<PlausibilityResult> {
  const now = (opts.nowMs ?? Date.now)();
  const fresh = opts.freshMs ?? FRESH_MS();
  const freshnessFiles = [activeTaskFile(sessionId), sessionStateFile(sessionId, 'tool-ledger')];

  let newestMtimeMs: number | null = null;
  for (const file of freshnessFiles) {
    try {
      const mtimeMs = (await stat(file)).mtimeMs;
      if (newestMtimeMs === null || mtimeMs > newestMtimeMs) newestMtimeMs = mtimeMs;
    } catch {
      // ENOENT/EACCES is absence, not liveness.
    }
  }
  const audit = await readAuditActivity(sessionId, now);
  // Preserve the pre-existing generic freshness semantics; explicit clock/death handling belongs only to the
  // audit-admission projection owner below, not unrelated active-task/tool-ledger mtimes.
  const freshSignal = newestMtimeMs !== null && now - newestMtimeMs < fresh;
  return {
    plausible: freshSignal || audit.active || audit.unknown,
    newestMtimeMs,
    probedFiles: [...freshnessFiles, ...audit.probedFiles],
  };
}
