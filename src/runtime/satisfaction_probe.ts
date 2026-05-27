/**
 * CMP.2 — satisfaction probe (async, task-group-gated).
 *
 * Authoritative spec: `docs/tasks/T-compression.md` CMP.2 + the
 * pre-research D1 (`docs/research/T-compression-pre-research-2026-05-27.md`).
 *
 * The locked design ([[project_memory_architecture_dual_surface_sync]]):
 * long-term memory compression is GATED by a user-satisfaction probe.
 * After a GROUP OF TASKS completes (a track/feature group), we want to
 * ask the user "satisfied with <group>?" — and their answer gates
 * whether the compression orchestrator (CMP.4) is allowed to consolidate
 * + delete that group's predecessor memories.
 *
 * D1 — LOCKED: the probe is ASYNC. It is NEVER a synchronous, blocking
 * user prompt mid-flow (that would be the d9-guard false-stop class +
 * would interrupt automation). Instead we APPEND a probe row to a
 * per-session JSONL buffer; the user answers at a natural boundary, and
 * `recordAnswer` writes the answer back. `readSatisfaction` exposes the
 * ANSWERED probes to the orchestrator. Same automation-buffer pattern as
 * `store_lesson.ts` / the wedge capture buffer.
 *
 * Dedup: at most ONE open (unanswered) probe per group at a time — a
 * second `emitProbe` for a group that already has an open probe is a
 * no-op, so a re-firing trigger doesn't pile up duplicate questions.
 *
 * Null-safety: an absent or malformed buffer yields `[]` (never throws)
 * — the orchestrator treats "no answered probe" as "not satisfied →
 * compress nothing", which is the fail-closed default.
 *
 * Storage: `~/.opensquid/sessions/<sessionId>/satisfaction-probe.jsonl`
 * (OPENSQUID_HOME-overridable so tests isolate to a mkdtemp).
 *
 * Imports from: node:fs/promises, node:path, ./paths.js.
 * Imported by: src/runtime/hooks/session-end.ts (emit trigger);
 *   src/runtime/compression_orchestrator.ts (read path, CMP.4).
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { OPENSQUID_HOME } from './paths.js';

/**
 * One probe row. `emitted_at` set on emit; the answer fields
 * (`satisfied` + optional `confidence` + `answered_at`) are absent until
 * the user responds. The buffer is append-only — an answer is a NEW row
 * for the same group (the latest answered row wins per group), so we
 * never rewrite history (the locked anti-drift discipline).
 */
export interface SatisfactionProbe {
  group: string;
  emitted_at: string;
  satisfied?: boolean;
  confidence?: number;
  answered_at?: string;
}

/** Buffer path. OPENSQUID_HOME-aware so tests isolate to mkdtemp. */
export function probeBufferPath(sessionId: string): string {
  return join(OPENSQUID_HOME(), 'sessions', sessionId, 'satisfaction-probe.jsonl');
}

/**
 * Derive the feature "group" key from an active task. A track-style
 * task id (`"CMP.4"`) groups by its track prefix (`"CMP"`) so all tasks
 * in a track share ONE probe — the locked design's "after a group of
 * features completes". Falls back to the bare task id, then the subject.
 * Returns `null` when nothing usable is present.
 */
export function groupFromTask(
  task: { taskId?: string; id?: string; subject?: string } | null | undefined,
): string | null {
  if (!task) return null;
  const tid = task.taskId?.trim();
  if (tid) {
    const dot = tid.indexOf('.');
    return dot > 0 ? tid.slice(0, dot) : tid;
  }
  const subject = task.subject?.trim();
  if (subject) return subject;
  const id = task.id?.trim();
  if (id) return id;
  return null;
}

/** Parse the buffer into rows; `[]` on absent/malformed (no throw). */
async function readRows(sessionId: string): Promise<SatisfactionProbe[]> {
  let raw: string;
  try {
    raw = await readFile(probeBufferPath(sessionId), 'utf8');
  } catch {
    return [];
  }
  const rows: SatisfactionProbe[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof (parsed as { group: unknown }).group === 'string' &&
        typeof (parsed as { emitted_at: unknown }).emitted_at === 'string'
      ) {
        const o = parsed as Record<string, unknown>;
        rows.push({
          group: o.group as string,
          emitted_at: o.emitted_at as string,
          ...(typeof o.satisfied === 'boolean' ? { satisfied: o.satisfied } : {}),
          ...(typeof o.confidence === 'number' ? { confidence: o.confidence } : {}),
          ...(typeof o.answered_at === 'string' ? { answered_at: o.answered_at } : {}),
        });
      }
    } catch {
      // Skip a single malformed line rather than failing the whole read.
    }
  }
  return rows;
}

async function appendRow(sessionId: string, row: SatisfactionProbe): Promise<void> {
  const path = probeBufferPath(sessionId);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(row) + '\n', 'utf8');
}

/** A probe for `group` is "open" if it was emitted and not yet answered. */
function hasOpenProbe(rows: SatisfactionProbe[], group: string): boolean {
  // An answer for a group closes it; track the latest state per group.
  let open = false;
  for (const r of rows) {
    if (r.group !== group) continue;
    if (r.answered_at !== undefined) open = false;
    else open = true;
  }
  return open;
}

/**
 * Emit a probe for `group` — appends an unanswered row UNLESS one is
 * already open for the group (dedup). Async + append-only; never blocks.
 */
export async function emitProbe(
  sessionId: string,
  group: string,
  nowIso: () => string = () => new Date().toISOString(),
): Promise<void> {
  if (!group.trim()) return;
  const rows = await readRows(sessionId);
  if (hasOpenProbe(rows, group)) return; // dedup: one open probe per group
  await appendRow(sessionId, { group, emitted_at: nowIso() });
}

/**
 * Record the user's answer for `group` — appends an answered row.
 * No-op if there is no open probe for the group (nothing to answer).
 */
export async function recordAnswer(
  sessionId: string,
  group: string,
  satisfied: boolean,
  confidence?: number,
  nowIso: () => string = () => new Date().toISOString(),
): Promise<void> {
  const rows = await readRows(sessionId);
  const open = rows.find((r) => r.group === group && r.answered_at === undefined);
  if (!open) return;
  await appendRow(sessionId, {
    group,
    emitted_at: open.emitted_at,
    satisfied,
    ...(confidence !== undefined ? { confidence } : {}),
    answered_at: nowIso(),
  });
}

/**
 * Answered probes only, latest answer per group — what the orchestrator
 * (CMP.4) reads. `[]` on absent/malformed buffer (fail-closed).
 */
export async function readSatisfaction(sessionId: string): Promise<SatisfactionProbe[]> {
  const rows = await readRows(sessionId);
  const latest = new Map<string, SatisfactionProbe>();
  for (const r of rows) {
    if (r.answered_at === undefined) continue;
    latest.set(r.group, r); // later rows overwrite → latest answer wins
  }
  return [...latest.values()];
}
