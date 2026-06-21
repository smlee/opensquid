/**
 * Worksheet CLI backend (T-scope-worksheet / wg-7d649d90f26a). `opensquid worksheet show` resolves
 * the ACTIVE worksheet from the `coding-flow-worksheet-path` session-state key (single-writable-home:
 * the path is the one pointer), parses it, projects its live log, and renders the markdown view.
 *
 * Imports from: ../session_state.js, ./parse.js, ./projection.js, ./render.js.
 * Imported by: src/cli.ts (the `worksheet` command action).
 */
import { readSessionStateValue } from '../session_state.js';
import { parseWorksheet } from './parse.js';
import { projectScopes } from './projection.js';
import { renderWorksheet } from './render.js';

export interface WorksheetShowResult {
  ok: boolean;
  text: string;
}

/** Render the active worksheet (or a `--path`-supplied one) for `sessionId`. */
export async function runWorksheetShow(
  sessionId: string,
  override?: string,
): Promise<WorksheetShowResult> {
  const path =
    override ??
    ((await readSessionStateValue(sessionId, 'coding-flow-worksheet-path').catch(() => null)) as
      | string
      | null);
  if (path === null || path === '') {
    return { ok: false, text: 'no active worksheet (no coding-flow-worksheet-path set)' };
  }
  const ws = parseWorksheet(path);
  if ('error' in ws) return { ok: false, text: `invalid worksheet ${path}: ${ws.error}` };
  const proj = await projectScopes(ws, sessionId, path);
  return { ok: true, text: renderWorksheet(ws, proj) };
}
