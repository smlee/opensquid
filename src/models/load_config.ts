/* eslint-disable @typescript-eslint/require-await */
/**
 * Models config loader — three-source precedence resolver (PR-followup).
 *
 * Precedence (highest → lowest):
 *
 *   1. `OPENSQUID_MODELS_CONFIG_INLINE` env var (JSON object) — test seam +
 *      Phase 1 power-user override. Same shape as the Phase-1 stub.
 *   2. User-level `~/.opensquid/models.yaml` — the user's persistent override
 *      file (NOT YET WIRED; reserved for a Phase 2.4 follow-up that ships
 *      the file path + schema reuse). When wired, this layer lets a user
 *      pin a vendor binding without editing every pack they install.
 *   3. Pack-shipped `models.yaml` — folded into `Pack.models` by the loader
 *      (PR-followup). Acts as the out-of-the-box default for any alias a
 *      pack references; the user can override per-alias via layer 2 (or
 *      per-call via layer 1 for tests).
 *   4. Empty record — downstream callers report `Unknown model alias`.
 *
 * Why a pack-aware resolver beats the Phase-1 stub: packs DECLARE their
 * alias contract in their own `models.yaml` (`fast_classifier: { mode: ...
 * impl: cli, cli: claude }` etc.) so a pack can ship with sensible defaults
 * out of the box. Without this layer, every pack required the user to
 * pre-author a user-level `models.yaml` BEFORE any rule could fire — the
 * "models.yaml present but ignored" UX surfaced in the PR.7 closure.
 *
 * The `packModels` arg is intentionally optional + only-merge-when-defined
 * so the env-var test seam keeps its existing one-arg behavior — no
 * existing test needs touching. Callers that have access to the active
 * pack list (`functions/llm.ts` via `EvalCtx`) thread the pack-shipped
 * models through; callers that don't (legacy daemon startup) get the
 * pre-PR-followup behavior.
 *
 * Env-var injection mirrors `OPENSQUID_HOME` (see `runtime/paths.ts`).
 *
 * Imports from: ./types.js.
 * Imported by: functions/llm.ts, runtime/agent_bridge/daemon.ts,
 *   setup/schedule_nl.ts.
 */

import type { ModelsConfig } from '../packs/schemas/models.js';

import type { ModelAliasConfig } from './types.js';

/**
 * Resolve the merged model-alias map for the current call.
 *
 * @param packModels optional pack-shipped models map (from `Pack.models`).
 *                   When provided, used as the LOWEST-precedence layer; env
 *                   var overrides any matching alias. When `undefined`, only
 *                   the env-var stub contributes — preserves Phase 1 contract.
 */
export async function loadModelsConfig(
  packModels?: ModelsConfig,
): Promise<Record<string, ModelAliasConfig>> {
  // Layer 3 first (lowest precedence) — pack-shipped aliases provide the
  // baseline. Spread into a fresh object so we never mutate the caller's
  // Pack.models map.
  const merged: Record<string, ModelAliasConfig> =
    packModels !== undefined
      ? { ...(packModels as unknown as Record<string, ModelAliasConfig>) }
      : {};

  // Layer 2 (user-level YAML) — RESERVED. The user-level loader lands in a
  // future PR-followup-2; until then `~/.opensquid/models.yaml` is read by
  // the setup wizard but not consulted by the runtime resolver. Documented
  // here so the precedence chain is visible at the resolve site.

  // Layer 1 (highest precedence) — env-var inline override. Always overrides
  // pack-shipped + user-level entries for matching aliases; new aliases at
  // this layer are accepted (tests inject ad-hoc aliases).
  const inline = process.env.OPENSQUID_MODELS_CONFIG_INLINE;
  if (inline !== undefined && inline.length > 0) {
    try {
      const parsed = JSON.parse(inline) as unknown;
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        // Trust the shape — Phase 2's full schema-validated user-yaml loader
        // will Zod-validate at the user-yaml layer. The env-var seam stays
        // permissive so tests don't have to construct schema-compliant input.
        Object.assign(merged, parsed as Record<string, ModelAliasConfig>);
      }
    } catch {
      // Fall through to whatever we already have from the pack layer.
    }
  }

  return merged;
}
