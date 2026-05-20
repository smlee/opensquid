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

import { appendFile, mkdir } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

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

// ---------------------------------------------------------------------------
// DriftEventWithProvenance — extends DriftEvent with subagent provenance.
//
// Task 6.4: when a subagent surfaces drifts during a Mode-A spawn, the
// parent's session-level catalog records each event PLUS the originating
// subagent's id and profession pack. This lets the audit-trail
// disambiguate "did the parent drift, or did a spawned reviewer drift?"
// without forcing readers to cross-reference the subagent's own pack
// catalog.
//
// Both provenance fields are optional because the session-level catalog
// also accepts events from the parent's own packs (no subagent context).
// The aggregator (`readAllDriftCatalogs`) reads them as plain `DriftEvent`
// today — structural subtyping makes that compatible. The MCP tool surface
// that wants to distinguish subagent vs parent events parses the JSONL
// directly with this richer type.
// ---------------------------------------------------------------------------

export interface DriftEventWithProvenance extends DriftEvent {
  subagentId?: string;
  professionPack?: string;
}

// ---------------------------------------------------------------------------
// SubagentSdkDrift — loose drift event shape as received from the SDK.
//
// Kept structurally identical to `src/functions/subagent.ts`'s `SubagentDrift`
// (we deliberately avoid a circular import — `drift_catalog.ts` is a lower
// layer than `functions/subagent.ts`). All fields optional / string-coerced
// at the write boundary.
// ---------------------------------------------------------------------------

export interface SubagentSdkDrift {
  timestamp?: string;
  pack?: string;
  ruleId?: string;
  level?: string;
  message?: string;
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

// ---------------------------------------------------------------------------
// recordSubagentDrifts — Task 6.4 roll-up write path.
//
// Append each subagent-surfaced drift event to the PARENT's session-level
// drift catalog (`sessions/<parentSessionId>/state/drift-catalog.jsonl`)
// enriched with the subagent's id + profession pack as provenance fields.
//
// The append target is the same JSONL file the session-level reader picks
// up (sentinel pack tag `<session>` in `readAllDriftCatalogs`). The
// aggregator returns these enriched events as plain `DriftEvent` because
// structural subtyping treats the extra `subagentId` / `professionPack`
// fields as ignored — a richer reader (e.g. the MCP tool surface that
// renders "Drift from subagent X under profession Y") parses the JSONL
// directly with the `DriftEventWithProvenance` type.
//
// Per Task 6.4 risk callout — "independent catalog write decision": the
// subagent ALSO persists its own pack-level catalog during its run (the
// SDK-side evaluator writes to `packs/<subagent-pack>/state/drift-catalog.jsonl`
// via the normal evaluator path). This function intentionally does NOT
// double-write to the subagent's pack catalog from the parent process —
// the subagent's evaluator owns that write, and the parent's role is
// roll-up to the SESSION-level view. Two catalog writes (subagent's pack
// catalog + parent's session catalog) is the documented dual-write per
// design doc §"Team modes" Mode A — "audit-trail at both layers".
//
// Field normalization: SDK drifts may have any subset of fields populated.
// We coerce every field via `String(... ?? '')` so the JSONL line is
// always well-formed even if the SDK omitted some fields. `timestamp` is
// the sort key in the aggregator, so a missing timestamp drops the event
// to the bottom of any chronological sort — that's a degraded-but-safe
// behavior, never a crash.
//
// Directory creation: `mkdir(..., { recursive: true })` is idempotent and
// matches the pattern used by `src/functions/state.ts`. We do it inside
// the loop to keep the function self-contained — the directory only needs
// to exist before the first append, but the cost of an extra mkdir per
// drift is negligible (the per-loop cost is `appendFile`, not `mkdir`).
//
// Empty drifts array: no-op (no file created). Matches the contract that
// a successful subagent with zero drifts produces zero catalog writes.
// ---------------------------------------------------------------------------

export async function recordSubagentDrifts(
  parentSessionId: string,
  subagentId: string,
  professionPack: string,
  drifts: SubagentSdkDrift[],
): Promise<void> {
  if (drifts.length === 0) return;

  const path = sessionLogFile(parentSessionId, 'drift-catalog');
  await mkdir(dirname(path), { recursive: true });

  for (const d of drifts) {
    const enriched: DriftEventWithProvenance = {
      timestamp: String(d.timestamp ?? ''),
      pack: String(d.pack ?? professionPack),
      ruleId: String(d.ruleId ?? ''),
      level: String(d.level ?? ''),
      message: String(d.message ?? ''),
      subagentId,
      professionPack,
    };
    await appendFile(path, `${JSON.stringify(enriched)}\n`, 'utf8');
  }
}
