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

import { OPENSQUID_HOME } from '../paths.js';
import { readSessionCwd } from '../session_state.js';
import { resolveProjectMarker, resolveProjectUuidFromEnv } from '../paths.js';
import { resolveActorId } from '../actor_id.js';
import { bindProject, workGraphStore } from '../../workgraph/store.js';

import { buildCoveredBy, planAudit } from './plan_audit.js';
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
 * Resolve the work-graph project for a session the SAME way the MCP server does (session→cwd→marker, then
 * env), degrading a null at any step to `'legacy-global'` (the read-must-not-break default).
 */
async function resolveWgProject(sessionId: string): Promise<string> {
  const cwd = await readSessionCwd(sessionId);
  const markerUuid = cwd === null ? null : ((await resolveProjectMarker(cwd))?.uuid ?? null);
  return markerUuid ?? resolveProjectUuidFromEnv() ?? 'legacy-global';
}

/**
 * Open a project-bound work-graph facade over the HOME store (mirrors MCP `getWorkGraphBase`). A fresh store
 * per call — the hook subprocess is short-lived. OPENSQUID_HOME is test-isolated (global-teardown).
 */
export async function openWg(sessionId: string): Promise<WorkGraphFacade> {
  const store = workGraphStore({
    dbUrl: `file:${join(OPENSQUID_HOME(), 'workgraph.db')}`,
    sourceDir: join(OPENSQUID_HOME(), 'store', 'issues'),
    actorId: await resolveActorId(),
  });
  await store.init();
  return bindProject(store, await resolveWgProject(sessionId));
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
  const issues = await reader.listIssues();
  const edges = await reader.listEdges();
  const designElementIds = ext.authoredElements.map((e) => e.id); // the INDEPENDENT universe (extractScope)
  const coveredBy = buildCoveredBy(designElementIds, issues);
  const report = planAudit({
    issueIds: issues.map((i) => i.id),
    edges,
    designElementIds,
    coveredBy,
  });
  return { acyclic: report.acyclic, complete: report.complete };
}
