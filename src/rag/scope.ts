/**
 * Recall-scope resolution (T-memory-scope-isolation). Resolves the caller's project namespace for a
 * scoped `recall(query, k, scope)`. The key is the UMBRELLA id (so loop + loop-engine + opensquid — one
 * umbrella, three project UUIDs — collapse to ONE namespace, matching how chat already keys inbox/lease),
 * falling back to the project UUID for a cwd in no umbrella, and null only when there is no project
 * context at all (a bare global CLI call).
 *
 * A null namespace is fail-closed at recall time: only `shared`-tier memories are returned (project
 * memory is never leaked when the project is unknown). Because this resolver falls back umbrella →
 * project-uuid, null is rare.
 *
 * Imports from: ../channels/routing.js, ../runtime/paths.js, ./types.js.
 * Imported by: the recall callers (mcp/tools/recall, functions/recall_pre_inject, functions/rag,
 *   runtime/agent_bridge/tools/recall, runtime/wedge/compression_deps).
 */
import { loadChannelsConfig, resolveUmbrellaForCwd } from '../channels/routing.js';
import { resolveProjectUuidFromEnv, walkForProjectUuid } from '../runtime/paths.js';

import type { RecallScope } from './types.js';

/** Resolve the recall namespace for `cwd`: umbrella → project-uuid → null. Never throws. */
export async function resolveRecallScope(cwd: string = process.cwd()): Promise<RecallScope> {
  try {
    const cfg = await loadChannelsConfig();
    const umbrella = cfg === null ? null : resolveUmbrellaForCwd(cfg, cwd);
    if (umbrella !== null) return { namespace: umbrella };
  } catch {
    // channels config absent/unreadable → fall through to project-uuid resolution
  }
  try {
    const proj = (await walkForProjectUuid(cwd)) ?? resolveProjectUuidFromEnv();
    return { namespace: proj };
  } catch {
    return { namespace: null };
  }
}

/**
 * The loud notice emitted when a scoped recall resolves to a null namespace — project memory is
 * withheld this turn. NEVER a silent forget (directly answers the "AI forgets what I told it" drift).
 * Callers that surface text (recall MCP, recall_pre_inject) prepend/emit this; null namespace is rare.
 */
export const NULL_SCOPE_NOTICE =
  '[opensquid] project unresolved (no umbrella/project context) → project-scoped memory withheld this turn; only shared memory recalled.';
