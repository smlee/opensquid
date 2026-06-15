/**
 * Recall-scope resolution (T-memory-scope-isolation; de-umbrella'd in
 * T-umbrella-confine-to-chat UCC.1). Resolves the caller's project namespace for a scoped
 * `recall(query, k, scope)`. The key is the PROJECT UUID from the nearest `.opensquid/project.json`
 * marker walking up from `cwd` (per-repo: opensquid resolves to opensquid, loop to loop), falling
 * back to the `OPENSQUID_PROJECT_UUID` env override, and null only when there is no project context
 * at all (a bare/global CLI call).
 *
 * The PROCESS layer is umbrella-AGNOSTIC: this resolver never reads `channels.json`. Umbrella is a
 * chat-routing concern only (inbox/lease/delivery); a session's working repo determines its memory
 * scope, not the chat umbrella it belongs to.
 *
 * A null namespace is fail-closed at recall time: only `shared`-tier memories are returned (project
 * memory is never leaked when the project is unknown).
 *
 * Imports from: ../runtime/paths.js, ./types.js.
 * Imported by: mcp/tools/recall, mcp/tools/memorize, functions/recall_pre_inject, functions/rag,
 *   runtime/agent_bridge/tools/recall, runtime/wedge/compression_deps, setup/cli/memory,
 *   setup/migrate/auto_memory_snapshot. All eight use the cwd default; in MCP-server processes
 *   that cwd is normalized at boot by mcp/anchor.ts (host-controlled spawn cwd).
 */
import { resolveProjectMarker, resolveProjectUuidFromEnv } from '../runtime/paths.js';

import type { RecallScope } from './types.js';

/** Resolve the recall namespace for `cwd`: nearest `.opensquid/project.json` marker → env → null.
 *  Per-repo and umbrella-agnostic (never reads channels.json). Never throws. */
export async function resolveRecallScope(cwd: string = process.cwd()): Promise<RecallScope> {
  const marker = await resolveProjectMarker(cwd);
  if (marker !== null) return { namespace: marker.uuid };
  return { namespace: resolveProjectUuidFromEnv() };
}

/**
 * The loud notice emitted when a scoped recall resolves to a null namespace — project memory is
 * withheld this turn. NEVER a silent forget (directly answers the "AI forgets what I told it" drift).
 * Callers that surface text (recall MCP, recall_pre_inject) prepend/emit this; null namespace is rare.
 */
export const NULL_SCOPE_NOTICE =
  '[opensquid] project unresolved (no .opensquid/project.json marker) → project-scoped memory withheld this turn; only shared memory recalled.';
