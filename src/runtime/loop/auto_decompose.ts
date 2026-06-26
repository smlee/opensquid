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
import { extractScope } from './scope_extract.js';

/**
 * The minimal work-graph surface auto-decompose needs (a structural subset of `WorkGraphFacade`): create an
 * issue (returning its id) + add a `blocks` edge. `createIssue` returns the full Issue, of which only `.id` is
 * read here. The live caller passes the project-bound facade (`getWorkGraph()`).
 */
export interface AutoDecomposeWg {
  createIssue(i: { title: string; body: string }): Promise<{ id: string }>;
  addEdge(from: string, to: string, type: 'blocks'): Promise<void>;
}

/**
 * Read the artifact's elements via `extractScope` and populate `wg` with one stamped issue per element plus the
 * declared `blocks` edges. A missing/empty artifact (extractScope → null) is a no-op (nothing to populate).
 */
export async function autoDecompose(artifactPath: string, wg: AutoDecomposeWg): Promise<void> {
  const ext = await extractScope(artifactPath);
  const idOf = new Map<string, string>();
  for (const el of ext?.authoredElements ?? []) {
    // stamp the source element id so coverage is a deterministic JOIN (buildCoveredBy)
    const issue = await wg.createIssue({ title: el.id, body: `sourceElementId:${el.id}` });
    idOf.set(el.id, issue.id);
  }
  // issues+EDGES (the deliverable): a depended-on element BLOCKS its dependent (so acyclic is non-vacuous).
  for (const d of ext?.deps ?? []) {
    const from = idOf.get(d.dependsOn);
    const to = idOf.get(d.element);
    if (from !== undefined && to !== undefined) await wg.addEdge(from, to, 'blocks');
  }
}
