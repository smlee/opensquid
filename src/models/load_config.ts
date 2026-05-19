/* eslint-disable @typescript-eslint/require-await */
/**
 * Models config loader — STUB for Phase 1.
 *
 * The real loader (Phase 2) reads `~/.opensquid/models.yaml`, validates
 * each alias against a Zod schema, and merges in user overrides. Phase 1
 * doesn't have the YAML loader yet, so this function returns an empty
 * record by default — but it honours an `OPENSQUID_MODELS_CONFIG_INLINE`
 * env var carrying a JSON object of {alias → ModelAliasConfig} so that:
 *
 *   1. Tests can inject a fake CLI alias without monkey-patching imports.
 *   2. Phase-1 power users can wire one alias manually before Phase 2 ships.
 *
 * Env-var injection mirrors `OPENSQUID_HOME` (see `runtime/paths.ts`) —
 * one consistent test/override seam across the codebase.
 *
 * Invalid JSON in the env var is treated as "no config" rather than a
 * throw — a stuck env var should not prevent the runtime from starting.
 * The empty-config path returns `{}` and downstream callers report
 * `Unknown model alias "<name>"` via the standard arg_invalid channel,
 * which is the same UX the user gets when a real config is missing the
 * alias they tried to invoke.
 *
 * Imports from: ./types.js.
 * Imported by: functions/llm.ts.
 */

import type { ModelAliasConfig } from './types.js';

export async function loadModelsConfig(): Promise<Record<string, ModelAliasConfig>> {
  const inline = process.env.OPENSQUID_MODELS_CONFIG_INLINE;
  if (inline !== undefined && inline.length > 0) {
    try {
      const parsed = JSON.parse(inline) as unknown;
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        // Trust the shape — Phase 2's loader will Zod-validate. Tests are
        // the only Phase-1 consumer and they pass well-formed config.
        return parsed as Record<string, ModelAliasConfig>;
      }
    } catch {
      // Fall through to empty config.
    }
  }
  return {};
}
