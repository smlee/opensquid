/**
 * Table rendering for CLI.2 — `opensquid schedule list|next`.
 *
 * Split out of `schedule.ts` (file-size budget). Pure functions over rows;
 * picocolors handles ANSI styling. Columns mirror `kubectl get` ergonomics.
 *
 * Imports from: picocolors, ./schedule_state.
 * Imported by: src/setup/cli/schedule.ts.
 */

import pc from 'picocolors';

import type { ScheduleRow } from './schedule_state.js';

const LIST_COLS = ['ID', 'SOURCE', 'CRON', 'PACK', 'SKILL', 'STATUS', 'PAUSED'] as const;
const NEXT_COLS = ['ID', 'CRON', 'NEXT FIRE', 'IN'] as const;

function padCell(s: string, n: number): string {
  return s + ' '.repeat(Math.max(0, n - s.length));
}

export function timeUntil(future: Date, now: Date): string {
  const ms = future.getTime() - now.getTime();
  if (ms <= 0) return 'now';
  const s = Math.floor(ms / 1000);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days > 0) return `${String(days)}d ${String(hours)}h`;
  if (hours > 0) return `${String(hours)}h ${String(minutes)}m`;
  return `${String(minutes)}m`;
}

export function renderListTable(rows: readonly ScheduleRow[], color: boolean): string {
  const c = pc.createColors(color);
  const cells = rows.map((r) => [
    r.id,
    r.source,
    r.cron,
    r.pack,
    r.skill,
    r.status,
    r.paused ? 'paused' : 'active',
  ]);
  const widths = LIST_COLS.map((h, i) =>
    Math.max(h.length, ...cells.map((row) => (row[i] ?? '').length)),
  );
  const header = LIST_COLS.map((h, i) => c.bold(padCell(h, widths[i] ?? 0))).join('  ');
  const body = cells.map((row, rIdx) => {
    const r = rows[rIdx]!;
    return row
      .map((cell, i) => {
        const padded = padCell(cell, widths[i] ?? 0);
        if (i === LIST_COLS.length - 1) return r.paused ? c.dim(padded) : c.green(padded);
        return r.paused ? c.dim(padded) : padded;
      })
      .join('  ');
  });
  return [header, ...body].join('\n');
}

export function renderNextTable(
  rows: readonly { id: string; cron: string; nextFireAt: string | null }[],
  now: Date,
  color: boolean,
): string {
  const c = pc.createColors(color);
  const cells = rows.map((r) => [
    r.id,
    r.cron,
    r.nextFireAt ?? '(no future fire within 30d)',
    r.nextFireAt ? timeUntil(new Date(r.nextFireAt), now) : '—',
  ]);
  const widths = NEXT_COLS.map((h, i) =>
    Math.max(h.length, ...cells.map((row) => (row[i] ?? '').length)),
  );
  const header = NEXT_COLS.map((h, i) => c.bold(padCell(h, widths[i] ?? 0))).join('  ');
  const body = cells.map((row) => row.map((cell, i) => padCell(cell, widths[i] ?? 0)).join('  '));
  return [header, ...body].join('\n');
}
