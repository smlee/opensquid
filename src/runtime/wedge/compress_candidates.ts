/**
 * CMP.3 — compression-candidate collector (wedge extension, Seam 1).
 *
 * Authoritative spec: `docs/tasks/T-compression.md` CMP.3 + pre-research
 * §3 Seam 1 (`docs/research/T-compression-pre-research-2026-05-27.md`).
 *
 * The locked design: compression IS lesson-formation, so it rides the
 * SAME wedge cadence. After a lesson is PROMOTED (Stage 2), the memory
 * ids cited in that lesson's causal narrative (the engine's
 * `EvidenceRef::Memory` evidence refs, surfaced via `lesson.promote`'s
 * `cited_memory_ids`) are nominated as compression candidates: those
 * memories have now "earned a gist" by contributing to a graduated
 * lesson. The orchestrator (CMP.4) later reads these windows — gated by
 * the satisfaction probe (CMP.2) — and compresses them.
 *
 * OFF THE CRITICAL PATH: a candidate-collection failure must NEVER fail
 * or delay a lesson promotion. The caller wraps `collectCandidates` in a
 * best-effort try/catch; this module itself only ever appends to a
 * buffer (it does not promote, delete, or call the engine).
 *
 * Dedup: ids within a single window are deduped; the orchestrator
 * additionally dedups across windows in a group when it reads.
 *
 * Storage: `~/.opensquid/sessions/<sessionId>/compression-candidates.jsonl`
 * (OPENSQUID_HOME-overridable so tests isolate to a mkdtemp). Same
 * append-only automation-buffer pattern as the satisfaction probe.
 *
 * Imports from: node:fs/promises, node:path, ../paths.js.
 * Imported by: src/functions/lessons.ts (emit after promote);
 *   src/runtime/compression_orchestrator.ts (read path, CMP.4).
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { OPENSQUID_HOME } from '../paths.js';

/**
 * One compression-candidate window: the memory ids cited by a promoted
 * lesson, keyed by the feature group so the orchestrator can release
 * them when that group's satisfaction probe comes back "satisfied".
 */
export interface CompressionCandidateWindow {
  group: string;
  ids: string[];
  promotedLessonId: string;
  collected_at: string;
}

/** Buffer path. OPENSQUID_HOME-aware so tests isolate to mkdtemp. */
export function candidatesBufferPath(sessionId: string): string {
  return join(OPENSQUID_HOME(), 'sessions', sessionId, 'compression-candidates.jsonl');
}

/** Parse the buffer into windows; `[]` on absent/malformed (no throw). */
async function readWindows(sessionId: string): Promise<CompressionCandidateWindow[]> {
  let raw: string;
  try {
    raw = await readFile(candidatesBufferPath(sessionId), 'utf8');
  } catch {
    return [];
  }
  const out: CompressionCandidateWindow[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof (parsed as { group: unknown }).group === 'string' &&
        Array.isArray((parsed as { ids: unknown }).ids) &&
        typeof (parsed as { promotedLessonId: unknown }).promotedLessonId === 'string' &&
        typeof (parsed as { collected_at: unknown }).collected_at === 'string'
      ) {
        const o = parsed as Record<string, unknown>;
        const ids = (o.ids as unknown[]).filter((x): x is string => typeof x === 'string');
        out.push({
          group: o.group as string,
          ids,
          promotedLessonId: o.promotedLessonId as string,
          collected_at: o.collected_at as string,
        });
      }
    } catch {
      // Skip a single malformed line rather than failing the whole read.
    }
  }
  return out;
}

/**
 * Collect a promoted lesson's cited memory ids into a candidate window
 * appended to the per-session buffer. NO-OP when the lesson cites no
 * memories (no window emitted — nothing to compress). Ids are deduped
 * within the window. Append-only; never blocks; never touches the
 * engine.
 */
export async function collectCandidates(
  sessionId: string,
  lesson: { id: string; citedMemoryIds: string[]; group: string },
  nowIso: () => string = () => new Date().toISOString(),
): Promise<void> {
  if (!lesson.group.trim()) return;
  const ids = [...new Set(lesson.citedMemoryIds.filter((s) => typeof s === 'string' && s.trim()))];
  if (ids.length === 0) return; // a lesson citing no memories → no window
  const window: CompressionCandidateWindow = {
    group: lesson.group,
    ids,
    promotedLessonId: lesson.id,
    collected_at: nowIso(),
  };
  const path = candidatesBufferPath(sessionId);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(window) + '\n', 'utf8');
}

/**
 * Read the candidate windows for `group` — what the orchestrator
 * (CMP.4) consumes. `[]` on absent/malformed buffer (fail-closed →
 * nothing to compress).
 */
export async function readCandidates(
  sessionId: string,
  group: string,
): Promise<CompressionCandidateWindow[]> {
  const windows = await readWindows(sessionId);
  return windows.filter((w) => w.group === group);
}
