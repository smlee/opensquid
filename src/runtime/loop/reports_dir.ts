/**
 * V2-ENF.2/4 — the SAVED-report directory: `<project>/.opensquid/reports/`, NEVER the global `~/.opensquid`.
 *
 * Design-of-record: loop/docs/design/opensquid-reporting-model.md §3 + §2.
 * Only the "after" reports (after-stage / after-task / after-session / after-system) + the genesis startup
 * (before-system) are SAVED; every "before" report and the escalation interrupt are SURFACED only (never a file).
 * Reports are PROJECT DATA — under project-only operation the global home is mechanism-only, so nothing persists
 * there. This module owns the ONE place that resolves that directory + writes a saved report atomically, so a
 * relocation (the move off the legacy `docs/reports/`) is single-sourced.
 *
 * FAIL-SAFE: `projectReportsDirFor(cwd)` returns `null` for a marker-less cwd (no project scope in effect) rather
 * than leaking a write into the home root — the same home-scope-leak discipline `resolveProjectScopeRoot` holds.
 */
import { join } from 'node:path';

import { atomicWriteFile } from '../../storage/atomic_file.js';
import { resolveProjectScopeRoot } from '../paths.js';

/** The saved-reports directory under an already-resolved `.opensquid` scope root (`resolveProjectScopeRoot`). */
export function projectReportsDir(scopeRoot: string): string {
  return join(scopeRoot, 'reports');
}

/**
 * Resolve the saved-reports directory for a working directory by walking up to the project's `.opensquid` scope
 * root. Returns `null` when there is no project scope (never the global home) — the caller then skips the save
 * (surfaced-only degrade) rather than persisting outside the project.
 */
export async function projectReportsDirFor(cwd: string): Promise<string | null> {
  const scopeRoot = await resolveProjectScopeRoot(cwd);
  return scopeRoot === null ? null : projectReportsDir(scopeRoot);
}

/**
 * Atomically save a report `body` under `<project>/.opensquid/reports/<filename>` and return the ABSOLUTE path
 * written, or `null` when no project scope resolves from `cwd` (the report is then surfaced-only). `filename` is
 * the root-relative name a renderer produced (e.g. `after-stage-<taskId>-<date>.md`) — NOT a path with slashes.
 */
export async function saveProjectReport(
  cwd: string,
  filename: string,
  body: string,
): Promise<string | null> {
  const dir = await projectReportsDirFor(cwd);
  if (dir === null) return null; // no project scope → never write to the global home; surfaced-only
  const abs = join(dir, filename);
  await atomicWriteFile(abs, body);
  return abs;
}
