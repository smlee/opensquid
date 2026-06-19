/**
 * T4 — persist the genesis StartupReport (T-fsm-actor-rescope §T4).
 *
 * Genesis (T3c) produces a `StartupReport` (which packs connected/wedged/disabled, actor classifications,
 * failures) + a `recovery` flag (on `ReconcileResult`, NOT the report). T3c surfaced it only via an in-memory
 * callback. This persists it to `startup-report.json` under home so `opensquid daemon report` can surface it on
 * demand — the same read/atomic-write pattern as `state_file.ts`. The persisted form carries the boot timestamp
 * (`startedAt`) + `recovery` so the CLI can show staleness + the crash flag.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { atomicWriteFile } from '../atomic_write.js';
import { OPENSQUID_HOME } from '../paths.js';
import type { StartupReport } from './reconcile.js';

export interface PersistedStartupReport extends StartupReport {
  startedAt: number; // boot timestamp (ms) — the CLI shows it + uses it for the staleness label
  recovery: boolean; // ← ReconcileResult.recovery (a crash had no shutdown marker)
}

export const startupReportPath = (home: string = OPENSQUID_HOME()): string =>
  join(home, 'startup-report.json');

export async function writeStartupReport(
  report: StartupReport,
  recovery: boolean,
  startedAt: number,
  home: string = OPENSQUID_HOME(),
): Promise<void> {
  const persisted: PersistedStartupReport = { ...report, recovery, startedAt };
  await atomicWriteFile(startupReportPath(home), `${JSON.stringify(persisted, null, 2)}\n`);
}

/** Read the persisted report; absent/corrupt ⇒ null (no genesis report yet). */
export async function readStartupReport(
  home: string = OPENSQUID_HOME(),
): Promise<PersistedStartupReport | null> {
  try {
    return JSON.parse(await readFile(startupReportPath(home), 'utf8')) as PersistedStartupReport;
  } catch {
    return null;
  }
}
