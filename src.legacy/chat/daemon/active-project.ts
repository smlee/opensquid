/**
 * Resolve the active project's UUID for chat-routing operations
 * (v0.7.1 Phase E).
 *
 * Strategy:
 *   1. If `OPENSQUID_PROJECT_UUID` env var is set, use it verbatim.
 *   2. Walk up from `cwd` looking for `.opensquid/project.json` and
 *      return its uuid.
 *   3. Return null — the caller decides whether to error or fall back
 *      to the orphan path.
 *
 * Per-tool fallback: tools that need a project uuid surface a clear
 * error message instead of silently routing to orphan; the user can
 * run `opensquid project init` to create a card if missing.
 */

import { findProjectCard } from "../../project.js";

export async function resolveActiveProjectUuid(
  cwd: string = process.cwd(),
): Promise<string | null> {
  if (process.env.OPENSQUID_PROJECT_UUID) return process.env.OPENSQUID_PROJECT_UUID;
  const found = await findProjectCard(cwd);
  return found?.card.uuid ?? null;
}
