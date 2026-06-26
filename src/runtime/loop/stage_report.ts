/**
 * T2.12 — per-stage reports (SCOPE / PLAN / AUTHOR / CODE / DEPLOY).
 *
 * Each FSM stage emits a MANDATORY report: a dated, human-readable file under the active project's
 * `docs/reports/` AND (via the caller) a memory entry. The renderer is PURE — `iso` is injected, never
 * `Date.now()` — so the dated path + body are deterministic in fixtures. The file is a per-project
 * artifact (a regenerated projection), so it lives under the project root (the session cwd), NOT
 * `OPENSQUID_HOME`.
 *
 * The LIVE trigger is `v2_supply.ts`: it calls `emitStageReport` on each FSM transition LEAVING
 * SCOPE/PLAN/AUTHOR/DEPLOY (CODE is emitted by T2.9's loop_driver on `phases_complete`), and mirrors the
 * returned body into the session memory buffer. So all five stage reports have a named live caller — the
 * renderer is not dormant.
 *
 * Imports from: node:path, ../../storage/atomic_file.
 * Imported by: src/runtime/loop/v2_supply.ts (the live trigger) + loop_driver (T2.9, the CODE caller).
 */
import { join } from 'node:path';

import { atomicWriteFile } from '../../storage/atomic_file.js';

// 'CODE' is included (emitted by T2.9's loop_driver on phases_complete), even though v2_supply only
// emits SCOPE/PLAN/AUTHOR/DEPLOY on the leaving transition.
export type Stage = 'SCOPE' | 'PLAN' | 'AUTHOR' | 'CODE' | 'DEPLOY';

export interface StageReport {
  stage: Stage;
  taskId: string;
  summary: string;
  nextDirective: string;
  /** Only the SCOPE report carries the goal-alignment line (T2.10's live consumer). Omitted → no line. */
  goalAligned?: boolean;
}

/**
 * Render a plain-header report → a dated file path + the body text (also used for the memory mirror).
 * `iso` is passed in (no `Date.now()` — keeps the renderer pure/deterministic). The `## Goal alignment`
 * line is emitted ONLY when `goalAligned !== undefined`. Path: `docs/reports/<stage-lower>-<taskId>-<iso-date>.md`.
 */
export function renderStageReport(r: StageReport, iso: string): { path: string; body: string } {
  const goal =
    r.goalAligned === undefined
      ? '' // SCOPE report carries the goal-alignment line (T2.10's live consumer)
      : `\n## Goal alignment\n${r.goalAligned ? 'on the captured goal' : 'OFF the captured goal — destination drift'}\n`;
  const body = `# ${r.stage} report — ${r.taskId} (${iso})\n\n## Summary\n${r.summary}\n\n## Next\n${r.nextDirective}\n${goal}`;
  return {
    path: join('docs/reports', `${r.stage.toLowerCase()}-${r.taskId}-${iso.slice(0, 10)}.md`),
    body,
  };
}

/**
 * Atomically write the rendered report to `join(root, path)` and return the (root-relative) path. The
 * caller (v2_supply / loop_driver) mirrors the returned body into memory — the session-scoped memory write
 * needs a `sessionId` that this signature does not carry, so the mirror lives in the caller (see v2_supply).
 */
export async function emitStageReport(root: string, r: StageReport, iso: string): Promise<string> {
  const { path, body } = renderStageReport(r, iso);
  await atomicWriteFile(join(root, path), body); // + the caller mirrors `body` into memory (see v2_supply.ts)
  return path;
}
