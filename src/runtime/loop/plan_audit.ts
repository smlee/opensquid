/**
 * T2.5 — the PLAN gate producer: a deterministic, ZERO-LLM audit over the work-graph.
 *
 * Two facets the `fullstack-flow` PLAN gate predicates on (`plan.acyclic && plan.complete`):
 *   acyclic  — no cycle in the `blocks`+`parent-child` dependency edges (Kahn topological sort: every issue
 *              is reachable from the in-degree-0 frontier; a residual node ⇒ a cycle).
 *   complete — every design element of the INDEPENDENT universe (`extractScope` output, T2.4 — NOT
 *              auto-decompose's own issues) has ≥1 covering issue. The universe is independent of the populator,
 *              so if auto-decompose drops an element it stays `uncovered` and the gate blocks (non-circular).
 *
 * `buildCoveredBy` is the deterministic JOIN: it groups issues by the `sourceElementId:<id>` that
 * auto-decompose STAMPS into each issue body — a literal-match join, no LLM, no fuzzy matching.
 *
 * Spec: docs/tasks/T-v2-track2-discipline.md T2.5 ("Key code shapes").
 */

export interface PlanInput {
  /** every issue id in the project (the topo-sort node universe). */
  issueIds: string[];
  /** the folded edge projection; only `blocks`+`parent-child` participate in the cycle check. */
  edges: { from: string; to: string; type: string }[];
  /** the INDEPENDENT design-element universe (extractScope authoredElements ids). */
  designElementIds: string[];
  /** the deterministic JOIN: designElementId → covering issue ids (from `buildCoveredBy`). */
  coveredBy: Record<string, string[]>;
}

export interface PlanReport {
  acyclic: boolean;
  complete: boolean;
  /** the design elements (cited by id) that have zero covering issue. */
  cycles: string[];
  uncovered: string[];
}

/**
 * Audit the plan. Deterministic: identical input → identical report. Pure over the injected
 * `{issueIds, edges, designElementIds, coveredBy}` (no I/O — the caller supplies them).
 */
export function planAudit(p: PlanInput): PlanReport {
  // acyclic via Kahn over the dependency edges (blocks + parent-child).
  const rel = p.edges.filter((e) => e.type === 'blocks' || e.type === 'parent-child');
  const indeg = new Map<string, number>(p.issueIds.map((i) => [i, 0]));
  const adj = new Map<string, string[]>();
  for (const e of rel) {
    // Only count edges whose endpoints are known nodes (a dangling endpoint cannot create a cycle).
    if (!indeg.has(e.from) || !indeg.has(e.to)) continue;
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    const out = adj.get(e.from) ?? [];
    out.push(e.to);
    adj.set(e.from, out);
  }
  const q = p.issueIds.filter((i) => (indeg.get(i) ?? 0) === 0);
  let seen = 0;
  while (q.length > 0) {
    const n = q.shift();
    if (n === undefined) break;
    seen++;
    for (const m of adj.get(n) ?? []) {
      const d = (indeg.get(m) ?? 0) - 1;
      indeg.set(m, d);
      if (d === 0) q.push(m);
    }
  }
  const acyclic = seen === p.issueIds.length;
  // complete over the INDEPENDENT universe — an element with no covering issue is uncovered.
  const uncovered = p.designElementIds.filter((d) => (p.coveredBy[d] ?? []).length === 0);
  // cycles: the residual (un-`seen`) issue ids — the nodes still carrying in-degree, named for the message.
  const cycles = acyclic ? [] : p.issueIds.filter((i) => (indeg.get(i) ?? 0) > 0);
  return { acyclic, complete: uncovered.length === 0, cycles, uncovered };
}

/**
 * The deterministic coverage JOIN feeding `planAudit`: group issues by their stamped `sourceElementId`. The
 * `designElementIds` are the INDEPENDENT universe (`extractScope`, NOT autoDecompose's issue list) — so an
 * element auto-decompose dropped is absent from any issue body, stays `[]`, and the gate blocks. No LLM, no
 * fuzzy match — a literal `sourceElementId:<id>` regex over the body.
 */
export function buildCoveredBy(
  designElementIds: string[],
  issues: { id: string; body: string }[],
): Record<string, string[]> {
  const cov: Record<string, string[]> = Object.fromEntries(designElementIds.map((d) => [d, []]));
  for (const i of issues) {
    const m = /sourceElementId:(\S+)/.exec(i.body);
    if (m?.[1] !== undefined && Object.prototype.hasOwnProperty.call(cov, m[1]))
      cov[m[1]]?.push(i.id);
  }
  return cov;
}
