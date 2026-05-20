/**
 * Roll-up drift catalogs across pack layers (Task 5.4).
 *
 * Per `docs/opensquid-real-design.md` §"Phases 2–7 summary" Phase 5: every
 * pack writes its own `drift-catalog.jsonl` under
 * `~/.opensquid/packs/<id>/state/`, and the session writes a session-level
 * `drift-catalog.jsonl` under `~/.opensquid/sessions/<id>/state/`. The
 * runtime exposes the AGGREGATED view; pack-level catalogs are the
 * source-of-truth on disk, never mutated by the reader.
 *
 * `readAllDriftCatalogs` is the read-side companion. It walks every
 * supplied pack id + the session catalog, parses JSONL line-by-line,
 * decorates each event with its `pack` provenance, and chronologically
 * sorts the merged list by `timestamp`. Missing files are silently OK
 * (ENOENT swallowed): not every pack has emitted a drift event, and a
 * brand-new session has no session catalog yet.
 *
 * Provenance: the `pack` field in the returned `DriftEvent` always reflects
 * the FILE the event was read from (the pack id passed to `readAllDriftCatalogs`,
 * or `<session>` for the session-level catalog). Any `pack` field present
 * in the raw JSONL is OVERWRITTEN — the on-disk catalog can lie about its
 * pack origin, but the aggregator pins provenance to the actual file
 * location it found. This matters for audit + supports the MCP tool that
 * surfaces the aggregated view to humans.
 *
 * JSONL parsing: `.filter(Boolean)` discards the empty string after a
 * trailing newline (standard JSONL convention) and any blank line. A
 * malformed line throws synchronously inside the `for` loop; the caller
 * wraps the call so the MCP tool surface can degrade gracefully. Future
 * hardening could try/catch per line and surface counts of parse failures.
 *
 * Imports from: node:fs/promises, runtime/paths.ts.
 * Imported by: src/mcp/tools/list-drift-events.ts.
 */

import { readFile } from 'node:fs/promises';

import { packLogFile, sessionLogFile } from './paths.js';

export interface DriftEvent {
  /** ISO-8601 timestamp; sort key. */
  timestamp: string;
  /** Pack id that produced this event, or `<session>` for the session catalog. */
  pack: string;
  /** Rule id that produced the event. */
  ruleId: string;
  /** Verdict level — `block` / `warn` / `surface`. Loose-typed at the aggregator. */
  level: string;
  /** Human-readable verdict message. */
  message: string;
}

async function readJsonl(path: string, packTag: string): Promise<DriftEvent[]> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const out: DriftEvent[] = [];
  for (const line of raw.split('\n').filter(Boolean)) {
    const parsed = JSON.parse(line) as Partial<DriftEvent>;
    // Provenance OVERWRITE: trust the file location, not the file content,
    // for `pack`. See file-level comment.
    out.push({
      timestamp: String(parsed.timestamp ?? ''),
      ruleId: String(parsed.ruleId ?? ''),
      level: String(parsed.level ?? ''),
      message: String(parsed.message ?? ''),
      pack: packTag,
    });
  }
  return out;
}

export async function readAllDriftCatalogs(
  packIds: string[],
  sessionId: string,
): Promise<DriftEvent[]> {
  const all: DriftEvent[] = [];

  // Per-pack catalogs first. Order at this stage doesn't matter; the final
  // sort happens once below.
  for (const pid of packIds) {
    const events = await readJsonl(packLogFile(pid, 'drift-catalog'), pid);
    all.push(...events);
  }

  // Session-level catalog. Marked with the sentinel pack tag `<session>`
  // so consumers can render it differently in the aggregated view.
  const sessionEvents = await readJsonl(sessionLogFile(sessionId, 'drift-catalog'), '<session>');
  all.push(...sessionEvents);

  // Chronological sort. `localeCompare` on ISO-8601 strings is safe because
  // the format is monotonic alphabetically.
  return all.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}
