/**
 * T2.5 — the deterministic PLAN evidence (zero LLM), the work-graph half of the gate.
 *
 * The two facets the `fullstack-flow` PLAN gate predicates on (`plan.acyclic && plan.complete`):
 *   acyclic  — no cycle in the project's `blocks`+`parent-child` edges (Kahn, `planAudit`).
 *   complete — every design element of the INDEPENDENT universe (`extractScope` of the captured pre-research
 *              artifact, T2.4 — NOT auto-decompose's own issues) has ≥1 covering issue, via the deterministic
 *              `sourceElementId:<id>` JOIN (`buildCoveredBy`).
 *
 * Reads issues + edges through the work-graph facade (the `listIssues`/`listEdges` accessors) and the artifact
 * via `extractScope`. FAIL-CLOSED on a missing artifact (`extractScope` → null) → `{false, false}` (the gate
 * blocks): a PLAN with no captured scope is not provably complete.
 *
 * Spec: docs/tasks/T-v2-track2-discipline.md T2.5 ("Key code shapes" / "Acceptance criteria").
 */
import { join } from 'node:path';

import { readSessionCwd } from '../session_state.js';
import { resolveLocalStoreDir, resolveProjectMarker, resolveProjectUuidFromEnv } from '../paths.js';
import { resolveActorId } from '../actor_id.js';
import { workGraphStore } from '../../workgraph/store.js';

import { buildCoveredBy, planAudit, scopeToDecomposition } from './plan_audit.js';
import { extractScope } from './scope_extract.js';

import type { WorkGraphFacade } from '../../workgraph/types.js';

export interface PlanEvidence {
  acyclic: boolean;
  complete: boolean;
}

/** The minimal facade surface PLAN evidence reads (issues + edges). */
export interface PlanWgReader {
  listIssues(): Promise<{ id: string; body: string }[]>;
  listEdges(): Promise<{ from: string; to: string; type: string }[]>;
}

/**
 * Resolve the session's project UUID namespace (session→cwd→marker, then env), degrading a null at any step to
 * `'legacy-global'` (the read-must-not-break default). It is the `project` value STAMPED on work-graph ops and
 * harness-map rows (the in-file namespace column), NOT a store selector: since T-project-local-state PLS.2 the
 * workgraph store is project-local (see {@link openWg}, resolved by `resolveLocalStoreDir` with no uuid), and
 * since #26 HWS.1 (CLOSED decision 5) the `harness_map.db` binding overlay ALSO went PROJECT-LOCAL — it lives at
 * `<root>/.opensquid/harness_map.db` beside the work-graph, resolved by the SAME `resolveLocalStoreDir` opener
 * (see `defaultOpenMap` in `harness_graph_sync.ts`). This REVERSES the earlier PLS.2 §4-OUT classification that
 * kept the map global + uuid-partitioned; a project-local db holds one project, so the retained `project`
 * column is a harmless constant, not a partition key. No store is keyed by this uuid any longer.
 */
export async function resolveWgProject(sessionId: string): Promise<string> {
  const cwd = await readSessionCwd(sessionId);
  const markerUuid = cwd === null ? null : ((await resolveProjectMarker(cwd))?.uuid ?? null);
  return markerUuid ?? resolveProjectUuidFromEnv() ?? 'legacy-global';
}

/**
 * Open the session's PROJECT-LOCAL work-graph store (T-project-local-state PLS.2): `<root>/.opensquid/workgraph.db`
 * resolved from the session's cwd (nearest `.opensquid/` walking up). A fresh store per call — the hook
 * subprocess is short-lived. The store IS the project's (no `bindProject`); a {@link WorkGraphStore} is a
 * {@link WorkGraphFacade}. Test-isolated via `OPENSQUID_PROJECT_ROOT`.
 */
export async function openWg(sessionId: string): Promise<WorkGraphFacade> {
  const cwd = (await readSessionCwd(sessionId)) ?? process.cwd();
  const dir = await resolveLocalStoreDir(cwd);
  const store = workGraphStore({
    dbUrl: `file:${join(dir, 'workgraph.db')}`,
    sourceDir: join(dir, 'store', 'issues'),
    actorId: await resolveActorId(),
  });
  await store.init();
  return store;
}

/**
 * Compute the PLAN evidence for the session's work-graph against the captured pre-research artifact. The `wg`
 * reader is injectable (tests pass an in-memory/temp store); the default opens the HOME store bound to the
 * session's project. FAIL-CLOSED on a missing artifact.
 */
export async function planEvidence(
  sessionId: string,
  artifactPath: string,
  wg?: PlanWgReader,
): Promise<PlanEvidence> {
  const ext = await extractScope(artifactPath);
  if (ext === null) return { acyclic: false, complete: false }; // fail-closed: no captured scope
  const reader = wg ?? (await openWg(sessionId));
  const designElementIds = ext.authoredElements.map((e) => e.id); // the INDEPENDENT universe (extractScope)
  // PROPER evaluation: scope to THIS scope's decomposition (issues stamped with a sourceElementId in the
  // universe + the edges among them) — NOT the whole project namespace. Auditing the namespace conflates
  // unrelated backlog + foreign/un-ported nodes into the gate, blocking it indefinitely as the backlog grows.
  const { issues, edges } = scopeToDecomposition(
    await reader.listIssues(),
    await reader.listEdges(),
    designElementIds,
  );
  const coveredBy = buildCoveredBy(designElementIds, issues);
  const report = planAudit({
    issueIds: issues.map((i) => i.id),
    edges,
    designElementIds,
    coveredBy,
  });
  return { acyclic: report.acyclic, complete: report.complete };
}
