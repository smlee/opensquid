/**
 * Rendering helpers for `opensquid checkpoints` (CLI.6) — split out of
 * checkpoints.ts for the file-size budget.
 *
 * Two concerns:
 *   - `renderListTable` — fixed-column ASCII table for `checkpoints list`.
 *   - `parseLimit` / `formatAge` — small utilities used only by the list
 *     verb's table render.
 *
 * Column widths: 8-char runId prefix + 12-char pack + 14-char skill +
 * 14-char rule + step + age fit inside 100 cols. Comparable to Temporal
 * `tctl workflow list` — fixed columns over flexible widths because the
 * intended consumer is a human eyeballing a recovery scenario, not a
 * piped tool (which uses `show` for JSONL).
 *
 * Imports from: none.
 * Imported by: src/setup/cli/checkpoints.ts (+ checkpoints_actions.ts).
 */

import type { ListEntry } from './checkpoints_core.js';

/** Compact fixed-column table. */
export function renderListTable(rows: readonly ListEntry[]): string {
  const lines: string[] = [];
  lines.push(
    pad('RUN', 12) +
      pad('PACK', 14) +
      pad('SKILL', 16) +
      pad('RULE', 16) +
      pad('STEP', 6) +
      pad('AGE', 10),
  );
  for (const r of rows) {
    lines.push(
      pad(r.runId.slice(0, 10), 12) +
        pad(r.packId, 14) +
        pad(r.skill, 16) +
        pad(r.ruleId, 16) +
        pad(String(r.lastCompletedStep), 6) +
        pad(formatAge(r.ageMs), 10),
    );
  }
  return lines.join('\n');
}

export function parseLimit(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function pad(s: string, w: number): string {
  if (s.length >= w) return s.slice(0, w - 1) + ' ';
  return s + ' '.repeat(w - s.length);
}

function formatAge(ms: number): string {
  if (ms < 1000) return `${String(ms)}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${String(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${String(m)}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${String(h)}h`;
  return `${String(Math.floor(h / 24))}d`;
}
