/**
 * KANBAN.4 — the kanban project-namespace resolver's PURE core, extracted so its load-bearing throw is
 * unit-testable (the audit-flagged invariant). `resolveKanbanProject` in `mcp/server.ts` composes this with
 * the session→cwd→marker chain (`resolveMcpSessionId`→`readSessionCwd`→`resolveProjectMarker`).
 *
 * The namespace = the recall convention (`rag/scope.ts`: marker `uuid` else `OPENSQUID_PROJECT_UUID` env).
 * It THROWS on a null namespace — KANBAN.4's per-project-isolation invariant: a board write needs a concrete
 * key, so (unlike `set_goal.ts:35`, which degrades a null cwd to a global bucket) there is no shared fallback.
 * This divergence from the `set_goal` precedent is exactly why it must be tested rather than asserted.
 */
export function resolveProjectNamespace(markerUuid: string | null, envUuid: string | null): string {
  const ns = markerUuid ?? envUuid;
  if (ns === null) {
    throw new Error(
      'kanban: cannot resolve project namespace (no .opensquid/project.json marker, no OPENSQUID_PROJECT_UUID)',
    );
  }
  return ns;
}
