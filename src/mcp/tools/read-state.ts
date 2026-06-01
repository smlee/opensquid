/**
 * `read_state` MCP tool — read a session state key written by the
 * `write_state` primitive (functions/state.ts).
 *
 * State lives under `~/.opensquid/sessions/<session-id>/state/<key>.json`
 * and stores a single JSON value. ENOENT collapses to the string `"null"`
 * so consumers never have to switch on missing-vs-null. Any other I/O or
 * JSON-parse error surfaces as a non-secret error message; the file path
 * itself is intentionally NOT included in the output (audit constraint:
 * MCP tool outputs MUST NOT leak filesystem paths outside `~/.opensquid/`,
 * and even paths inside are excluded — the key alone is enough context).
 *
 * Args:
 *   - `key` (required string) — the state key, identical to what
 *     `write_state` was called with.
 *
 * Imports from: runtime/paths (sessionStateFile).
 * Imported by: mcp/server.ts (handler map).
 */

import { readFile } from 'node:fs/promises';

import { resolveMcpSessionId } from '../../runtime/hooks/session_id.js';
import { sessionStateFile } from '../../runtime/paths.js';

export interface ReadStateArgs {
  key: string;
}

export async function handleReadState(args: ReadStateArgs): Promise<string> {
  // FU.5/FU.8 — resolve the REAL session (was `process.env.CLAUDE_SESSION_ID ??
  // 'unknown'`, which CC never sets → always read sessions/unknown/). null → no
  // session resolvable → same graceful empty as a missing key.
  const sessionId = await resolveMcpSessionId();
  if (sessionId === null) return 'null';
  const file = sessionStateFile(sessionId, args.key);
  try {
    const raw = await readFile(file, 'utf8');
    return raw.trim();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'null';
    return `read_state error: ${(e as Error).message}`;
  }
}
