/**
 * WGL.3 — reconcile-on-re-decompose by RUN-ID (docs/tasks/T-workgraph-lifecycle.md, §6.5 decision).
 *
 * Replaces the old any-covered short-circuit (which dedup'd by "any element already covered", so a re-authored
 * scope with new element ids re-decomposed into a PARALLEL stub set while the old set stayed open). The reconcile
 * is keyed on the generation id WGL.2 stamps in each child body:
 *   - a child already carries `currentGen` → IDEMPOTENT (this generation is decomposed; do nothing).
 *   - children exist with a DIFFERENT (or absent) generation → SUPERSEDE: archive each prior-generation child
 *     (WGL.1's soft, reversible archive — kept as history, off `listReady`), THEN decompose the current one.
 *   - no children → FIRST decomposition.
 * Detection is by generation-id MISMATCH, NOT element-id set diff (§6.5), so a scope that adds/removes one
 * element still supersedes cleanly. Pure over an injected `WorkGraphFacade` (unit-testable off the FSM).
 *
 * Imports from: ./auto_decompose.js, ../../workgraph/types.js. Imported by: v2_supply.ts (the live caller).
 */
import { autoDecompose, deriveGenerationId } from './auto_decompose.js';

import type { ScopeExtract } from './scope_extract.js';
import type { WorkGraphFacade } from '../../workgraph/types.js';

/** The child body's generation stamp (WGL.2). Anchored multiline so a `sourceElementId:`/free-text line never
 *  mis-parses; a malformed/absent line → `null` → treated as a DIFFERENT (stale) generation (the safe direction). */
const GEN_RE = /^generationId:(.+)$/m;

export interface ReconcileResult {
  action: 'first' | 'idempotent' | 'superseded';
  archived: string[]; // the prior-generation child ids archived on a supersede
}

/**
 * Reconcile the active task's decomposition against the current artifact generation. See the file header for the
 * three branches. FAIL-OPEN is the CALLER's concern (v2_supply wraps this in its try/catch); a decompose/archive
 * error here propagates so the caller logs + ignores it (never breaks scope_write→plan).
 */
export async function reconcileDecomposition(
  wg: WorkGraphFacade,
  taskId: string,
  artifact: string,
  ext: ScopeExtract,
): Promise<ReconcileResult> {
  const currentGen = deriveGenerationId(ext);
  const [issues, edges] = await Promise.all([wg.listIssues(), wg.listEdges()]);
  const byId = new Map(issues.map((i) => [i.id, i]));
  // the active task's CURRENT children (via WGL.2 parent-child edges), excluding already-archived generations.
  const children = edges
    .filter((e) => e.type === 'parent-child' && e.from === taskId)
    .map((e) => byId.get(e.to))
    .filter((i): i is NonNullable<typeof i> => i !== undefined && i.status !== 'archived');
  const genOf = (i: { body: string }): string | null => GEN_RE.exec(i.body)?.[1] ?? null;
  if (children.some((c) => genOf(c) === currentGen)) return { action: 'idempotent', archived: [] };
  const stale = children.filter((c) => genOf(c) !== currentGen); // a DIFFERENT (or absent) generation → superseded
  for (const c of stale) await wg.archiveIssue(c.id, `superseded by generation ${currentGen}`);
  await autoDecompose(artifact, wg, { parentId: taskId, generationId: currentGen });
  return { action: stale.length > 0 ? 'superseded' : 'first', archived: stale.map((c) => c.id) };
}
