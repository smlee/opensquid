/**
 * `read_violations` MCP tool — return the raw JSONL contents of the current
 * session's `violations` log.
 *
 * File path is `~/.opensquid/sessions/<session-id>/state/violations.jsonl`
 * (resolved via `sessionLogFile`). Each line is one JSON object appended by
 * the `append_log` primitive. We return the file verbatim so the MCP client
 * can parse + render it however it wants; this tool stays a thin reader.
 *
 * Returns empty string when the log doesn't exist yet (no violations
 * recorded this session). Any other read error surfaces as a non-secret
 * error message; the absolute file path is NOT echoed (same audit
 * constraint as `read_state`).
 *
 * Imports from: runtime/paths (sessionLogFile).
 * Imported by: mcp/server.ts (handler map).
 */

import { readFile } from 'node:fs/promises';

import { sessionLogFile } from '../../runtime/paths.js';

export async function handleReadViolations(): Promise<string> {
  const sessionId = process.env.CLAUDE_SESSION_ID ?? 'unknown';
  const file = sessionLogFile(sessionId, 'violations');
  try {
    return await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return '';
    return `read_violations error: ${(e as Error).message}`;
  }
}
