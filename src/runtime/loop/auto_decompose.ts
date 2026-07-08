/**
 * T2.5 — auto-decompose: POPULATE work-graph issues + edges from a SCOPE artifact's elements.
 *
 * For each `authoredElement` of the artifact (`extractScope`, T2.4) it creates one issue, STAMPING the source
 * element id into the body as `sourceElementId:<id>` — so coverage is a deterministic literal JOIN
 * (`buildCoveredBy`), zero-LLM, no fuzzy matching. It then creates `blocks` edges from the artifact's declared
 * dependencies (`extractScope.deps`, parsed from `[needs: M]` refs) so `planAudit.acyclic` is MEANINGFUL (not
 * vacuous over zero edges). Edge direction: a depended-on element BLOCKS its dependent.
 *
 * The design-element universe consumed by `plan.complete` is `extractScope` output — the INDEPENDENT universe,
 * NOT auto-decompose's issues — so the completeness check is non-circular.
 *
 * Spec: docs/tasks/T-v2-track2-discipline.md T2.5 ("Key code shapes").
 */
import { createHash } from 'node:crypto';

import { extractScope, type ScopeExtract } from './scope_extract.js';

/**
 * The minimal work-graph surface auto-decompose needs (a structural subset of `WorkGraphFacade`): create an
 * issue (returning its id) + add a `blocks` OR `parent-child` edge (WGL.2 ownership). `createIssue` returns the
 * full Issue, of which only `.id` is read here. The live caller passes the project-bound facade (`getWorkGraph()`).
 */
export interface AutoDecomposeWg {
  createIssue(i: { title: string; body: string }): Promise<{ id: string }>;
  addEdge(from: string, to: string, type: 'blocks' | 'parent-child'): Promise<void>;
}

/**
 * WGL.2 — ownership stamped at creation: the decompose-root task PLUS this run's generation id. The `parentId`
 * edge gives graph-walkable parenthood (the reaper distinguishes an owned child from an orphan stub); the
 * `generationId` lets the reconcile (WGL.3) distinguish a superseded prior run from the current one.
 */
export interface DecomposeOwner {
  parentId: string; // the decompose-root TASK issue (v2_supply's active taskId)
  generationId: string; // deriveGenerationId(ext) — stable per artifact content, distinct across re-authoring
}

/**
 * WGL.2 — a PURE generation id: a content hash of the artifact's element universe (its ids + deps). No
 * clock/random, so the SAME scope reproduces the SAME id (idempotent re-fire) and a re-authored scope yields a
 * DIFFERENT id (letting WGL.3 detect a superseded generation by mismatch). Order-independent (both lists sorted).
 */
export function deriveGenerationId(ext: ScopeExtract): string {
  const ids = ext.authoredElements.map((e) => e.id).sort();
  const deps = ext.deps.map((d) => `${d.dependsOn}->${d.element}`).sort();
  return (
    'gen-' + createHash('sha256').update(JSON.stringify({ ids, deps })).digest('hex').slice(0, 12)
  );
}

/**
 * Read the artifact's elements via `extractScope` and populate `wg` with one stamped issue per element plus the
 * declared `blocks` edges AND (WGL.2) a `parent-child` ownership edge from `owner.parentId` to each child + the
 * `generationId:` stamp in each child body. A missing/empty artifact (extractScope → null) is a no-op.
 */
export async function autoDecompose(
  artifactPath: string,
  wg: AutoDecomposeWg,
  owner: DecomposeOwner,
): Promise<void> {
  const ext = await extractScope(artifactPath);
  if (ext === null) return; // missing/empty artifact — nothing to populate
  const idOf = new Map<string, string>();
  for (const el of ext.authoredElements) {
    // stamp BOTH the source element id (coverage JOIN — buildCoveredBy) AND the generation id (ownership
    // generation — WGL.3's reconcile parses it). Newline-separated so a simple split('\n') recovers both.
    const issue = await wg.createIssue({
      title: el.id,
      body: `sourceElementId:${el.id}\ngenerationId:${owner.generationId}`,
    });
    idOf.set(el.id, issue.id);
    await wg.addEdge(owner.parentId, issue.id, 'parent-child'); // OWNERSHIP: decompose-root → child (walkable)
  }
  // issues+EDGES (the deliverable): a depended-on element BLOCKS its dependent (so acyclic is non-vacuous).
  for (const d of ext.deps) {
    const from = idOf.get(d.dependsOn);
    const to = idOf.get(d.element);
    if (from !== undefined && to !== undefined) await wg.addEdge(from, to, 'blocks');
  }
}
