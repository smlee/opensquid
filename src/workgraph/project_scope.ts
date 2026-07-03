/**
 * T-WORKGRAPH-PROJECT-SCOPE (lap/loop agreement) — the ONE workgraph project-namespace coalesce,
 * shared by the MCP server's session→cwd→marker resolver (`resolveWgProject` in `mcp/server.ts`) and
 * the ralph loop's cwd→marker resolver (`resolveAndPublishLoopProject` in `setup/cli/ralph.ts`), so a
 * lap and the loop that spawned it degrade IDENTICALLY onto the same bucket.
 *
 * Precedence: the cwd-derived marker `uuid` wins; the `OPENSQUID_PROJECT_UUID` env is the fallback.
 * The ralph loop PUBLISHES its resolved project into that env before spawning laps (each lap inherits
 * `...process.env` via `runOneShotCli`), so a lap whose OWN session→cwd marker is unresolvable —
 * which is exactly why the lap otherwise lands on the empty `legacy-global` project instead of the
 * loop's live board — still resolves the loop's project through this fallback.
 *
 * Mirrors `kanban/project_scope.ts`'s `resolveProjectNamespace`, but DEGRADES a null to
 * `'legacy-global'` (the read-heavy workgraph must not break a marker-less session — the same
 * degrade `resolveWgProject` already documented) rather than throwing.
 */
export function resolveWgNamespace(markerUuid: string | null, envUuid: string | null): string {
  return markerUuid ?? envUuid ?? 'legacy-global';
}
