/**
 * `birth_or_repoint_worksheet` primitive (T-scope-worksheet / wg-7d649d90f26a).
 *
 * Fires from the coding-flow pre-research-write capture (placed AFTER cached_audit, gated on
 * GUESS_FREE — so it only runs when the pre-research write is allowed; no orphan on a blocked write).
 * Keeps the active worksheet IFF it is an IN-FLIGHT batch (ANY order scope still incomplete) whose
 * `order` contains this scope — INTER-SCOPE. Otherwise it is a NEW TRACK: birth a fresh `single`
 * worksheet (valid by construction) and repoint `coding-flow-worksheet-path` at it. The repoint (not
 * if-absent-only) is what prevents reusing a stale prior-track path.
 *
 * No validation here — the machine single is valid by construction; the SOFT GATE runs on
 * USER-authored worksheets at the worksheet-file write capture (via `validate_worksheet`).
 *
 * Imports from: zod, ../runtime/result.js, ../runtime/session_state.js, ../runtime/worksheet/parse.js,
 *   ../runtime/worksheet/projection.js, ./registry.js.
 * Imported by: src/functions/index.ts.
 */
import { z } from 'zod';

import { ok } from '../runtime/result.js';
import { readSessionStateValue, writeSessionStateValue } from '../runtime/session_state.js';
import { parseWorksheet, titleOf, writeWorksheetFile } from '../runtime/worksheet/parse.js';
import { projectScopes } from '../runtime/worksheet/projection.js';

import type { FunctionRegistry } from './registry.js';

const WS_PATH_KEY = 'coding-flow-worksheet-path';
const Args = z.object({ file_path: z.string().min(1), effective: z.string().default('') }).strict();

/** docs/research/T-<slug>-pre-research-*.md → the scope id `T-<slug>`. */
function slugOf(filePath: string): string {
  const m = /(T-[^/]+?)-pre-research-/.exec(filePath);
  return m?.[1] ?? filePath.replace(/^.*\//, '').replace(/\.md$/, '');
}

export function registerBirthOrRepointWorksheetFunction(registry: FunctionRegistry): void {
  registry.register({
    name: 'birth_or_repoint_worksheet',
    argSchema: Args,
    durable: false,
    memoizable: false,
    costEstimateMs: 8,
    execute: async (args, ctx) => {
      const thisScopeId = slugOf(args.file_path);
      const path = (await readSessionStateValue(ctx.sessionId, WS_PATH_KEY)) as string | null;
      const ws = path ? parseWorksheet(path) : null;
      // INTER-SCOPE iff the active worksheet is an in-flight batch (ANY scope incomplete) containing this scope.
      const interScope =
        ws !== null &&
        !('error' in ws) &&
        ws.mode === 'batch' &&
        ws.order.includes(thisScopeId) &&
        (await projectScopes(ws, ctx.sessionId, path!)).some((s) => !s.complete);
      if (interScope) return ok(null); // keep the in-flight batch worksheet

      // NEW TRACK → birth a single (valid by construction) + repoint the path key.
      const newPath = writeWorksheetFile(thisScopeId, {
        mode: 'single',
        scopes: [{ id: thisScopeId, summary: titleOf(args.effective ?? '', thisScopeId) }],
        order: [thisScopeId],
      });
      await writeSessionStateValue(ctx.sessionId, WS_PATH_KEY, newPath);
      return ok(null);
    },
  });
}
