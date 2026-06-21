/**
 * Worksheet VIEW renderer (T-scope-worksheet / wg-7d649d90f26a) — pure projection→markdown.
 * The rendered markdown is a READ-ONLY view (single-writable-home): the authored plan is the
 * worksheet file; the log half (complete/commits/active) is recomputed from `projectScopes` and shown
 * here, never persisted. Used by `opensquid worksheet show` and the handoff surface.
 *
 * Imports from: ../../packs/schemas/worksheet.js (type), ./projection.js (type), ./active_scope.js.
 */
import type { Worksheet } from '../../packs/schemas/worksheet.js';
import { deriveActiveScope } from './active_scope.js';
import type { ScopeProjection } from './projection.js';

/** Render a worksheet + its live projection as a markdown checklist view. */
export function renderWorksheet(ws: Worksheet, proj: ScopeProjection[]): string {
  const active = deriveActiveScope(ws, proj);
  const head = `# Worksheet — ${ws.mode} (${proj.filter((p) => p.complete).length}/${ws.order.length} complete)`;
  const lines = ws.order.map((id, idx) => {
    const p = proj.find((x) => x.id === id);
    const scope = ws.scopes.find((s) => s.id === id);
    const mark = p?.complete ? '✅' : idx === active.i && !active.done ? '▶️' : '⬜';
    const summary = scope?.summary ?? '';
    const issue = scope?.issue ? ` (${scope.issue})` : '';
    const commits = p && p.commits.length > 0 ? ` — ${p.commits.length} commit(s)` : '';
    return `- ${mark} ${id}${issue}${summary ? ` — ${summary}` : ''}${commits}`;
  });
  const footer = active.done
    ? '\n_All scopes complete._'
    : active.scope
      ? `\n_Active: ${active.scope.id} (${active.i + 1}/${active.n})._`
      : '';
  return [head, '', ...lines, footer].join('\n');
}
