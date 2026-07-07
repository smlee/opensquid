/**
 * Audit-CLI persistence helpers (CLI.5) — split out of audit.ts for the
 * file-size budget.
 *
 * Two concerns live here:
 *
 *   1. `defaultAuditDbPath` — `file:${OPENSQUID_HOME()}/opensquid.db`. The
 *      same DB as CheckpointStore + RateLimiter — one libsql file per
 *      install. The audit_log table is created on first `init()`; no
 *      separate migration step.
 *
 *   2. `parseDurationToMs` — shared with permissions_actions.ts (CLI.4)
 *      but the import direction is reversed for CLI.5 to avoid leaking
 *      permissions-state types into the audit verb. Same `(\d+)(s|m|h|d)`
 *      regex; refactor candidate when a third caller appears.
 *
 * Imports from: node:path, ../../runtime/paths.
 * Imported by: src/setup/cli/audit.ts + audit_actions.ts.
 */

import { OPENSQUID_HOME } from '../../runtime/paths.js';

export function defaultAuditDbPath(): string {
  // SPLIT BOUNDARY (T-project-local-state PLS.3, pre-research §5): this reads the daemon's `audit_log` table, NOT
  // the checkpoints — so it follows the daemon (GLOBAL), not the project-local checkpoint readers
  // (`checkpoints.ts`/`trace.ts`). Do NOT repoint onto `resolveLocalStoreDir`: a local reader over the
  // globally-written audit_log is the split-brain the design forbids. Only the checkpoint + loop TABLES moved.
  return `file:${OPENSQUID_HOME()}/opensquid.db`;
}

const DURATION_RE = /^(\d+)(s|m|h|d)$/;

export function parseDurationToMs(spec: string): number | null {
  const m = DURATION_RE.exec(spec.trim());
  if (!m) return null;
  const n = Number.parseInt(m[1] ?? '0', 10);
  if (!Number.isFinite(n) || n < 0) return null;
  switch (m[2]) {
    case 's':
      return n * 1000;
    case 'm':
      return n * 60_000;
    case 'h':
      return n * 3_600_000;
    case 'd':
      return n * 86_400_000;
    default:
      return null;
  }
}

/** Human-readable timestamp for CLI output. ISO-8601 with millisecond
 *  precision — same posture as macOS Console.app's structured-log column
 *  (`2026-05-20T09:00:00.123`). Local-TZ formatting deferred to a future
 *  `--local-tz` flag if requested. */
export function formatTimestamp(ms: number): string {
  return new Date(ms).toISOString();
}
