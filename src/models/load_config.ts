/**
 * Models config loader — three-source precedence resolver (PR-followup).
 *
 * Precedence (highest → lowest):
 *
 *   1. `OPENSQUID_MODELS_CONFIG_INLINE` env var (JSON object) — test seam +
 *      Phase 1 power-user override. Same shape as the Phase-1 stub.
 *   2. User-level `~/.opensquid/models.yaml` — the user's persistent override
 *      file. WIRED (T-FLOW-UNSKIPPABLE F0c): read + schema-validated here, merged
 *      over the pack layer. Lets a user pin a vendor binding without editing every
 *      pack. (Previously reserved/unwired — which silently broke every pack alias
 *      the user defined only at this layer, e.g. `reasoning`, so the audit subagents
 *      failed `arg_invalid` and the coding-flow FSM could never advance.)
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

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parse as parseYaml } from 'yaml';

import { ModelsConfig } from '../packs/schemas/models.js';
import { OPENSQUID_HOME } from '../runtime/paths.js';

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

  // Layer 2 (user-level YAML) — WIRED (T-FLOW-UNSKIPPABLE F0c). Read
  // `~/.opensquid/models.yaml` and merge OVER the pack layer. Without this the
  // runtime never consulted the user's file, so a pack alias like `reasoning`
  // resolved to undefined → `subagent_call` failed `arg_invalid` → the
  // guess/spec audits never ran → the coding-flow FSM was stuck at `scoping`
  // forever (the flow was un-completable). Fail-SOFT: absent / unreadable /
  // schema-invalid YAML is skipped (the resolver must NEVER throw — a model
  // misconfig must not crash a hook). Validated via the same `ModelsConfig`
  // schema the pack/wizard use.
  try {
    const raw = await readFile(join(OPENSQUID_HOME(), 'models.yaml'), 'utf8');
    const parsed = ModelsConfig.safeParse(parseYaml(raw));
    if (parsed.success) {
      Object.assign(merged, parsed.data as Record<string, ModelAliasConfig>);
    }
  } catch {
    // absent / unreadable / invalid YAML → no user-level overrides
  }

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
