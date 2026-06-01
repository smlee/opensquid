/**
 * `list_drift_events` MCP tool — aggregated drift catalog view across the
 * supplied pack ids + the active session catalog (Task 5.4).
 *
 * Reads pack-level catalogs from `~/.opensquid/packs/<id>/state/drift-catalog.jsonl`
 * and the session-level catalog from `~/.opensquid/sessions/<session>/state/
 * drift-catalog.jsonl`. Returns the merged + chronologically sorted list
 * as JSON (one-line, no pretty-printing — the MCP client formats output
 * however it wants).
 *
 * Args:
 *   - `packs` (optional string[]) — pack ids whose catalogs to include.
 *     Empty / missing → session catalog only.
 *
 * Like the other read-only MCP tools, ENOENT collapses to "no events" (an
 * empty `[]`) rather than surfacing a filesystem path. Filesystem paths are
 * NEVER echoed back to the MCP client (same audit constraint as
 * `read_state` / `read_violations`).
 *
 * Imports from: runtime/drift_catalog.ts.
 * Imported by: mcp/server.ts (handler map).
 */

import { readAllDriftCatalogs } from '../../runtime/drift_catalog.js';
import { resolveMcpSessionId } from '../../runtime/hooks/session_id.js';

export interface ListDriftEventsArgs {
  packs?: string[];
}

export async function handleListDriftEvents(args: ListDriftEventsArgs): Promise<string> {
  // FU.8 — resolve the real session (was `?? 'unknown'`). null → no events.
  const sessionId = await resolveMcpSessionId();
  if (sessionId === null) return '[]';
  try {
    const events = await readAllDriftCatalogs(args.packs ?? [], sessionId);
    return JSON.stringify(events);
  } catch (e) {
    return `list_drift_events error: ${(e as Error).message}`;
  }
}
