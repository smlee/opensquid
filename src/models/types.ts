/**
 * Model-alias types: the contract a pack's `llm_classify` / `subagent_call`
 * sees, independent of which backend the user has wired up.
 *
 * Architecture (per `project_opensquid_model_neutral_subagent_primitive`):
 * packs declare ABSTRACT aliases (`fast_classifier`, `narrative_writer`);
 * the user's `models.yaml` maps each alias to a concrete backend. The
 * runtime NEVER hardcodes vendor names — every concrete model id or
 * binary name a vendor would recognise lives in user config only, never
 * in source.
 *
 * Five LLM call modes survive into Phase 1 as a type, but only the
 * `subscription + cli` strategy is implemented here. The other four
 * (subscription/sdk, api, local, mcp) are landed in cross-cutting tasks
 * LLM.1–LLM.4 — until then the dispatcher hands back a stub strategy
 * that rejects with a "not yet implemented" message naming the mode.
 *
 * Imports from: nothing.
 * Imported by: models/dispatcher.ts, models/strategies/*, models/load_config.ts,
 *   functions/llm.ts.
 */

export type ModelMode = 'subscription' | 'api' | 'local' | 'mcp';

// `impl` distinguishes how a mode is invoked. For `subscription`, the two
// branches are `cli` (spawn the user's host binary, pipe prompt via stdin)
// and `sdk` (programmatic library call — needed for Mode A subagents that
// must observe the parent session). For `api` / `local` / `mcp` the impl
// field is unused; left optional rather than introducing per-mode unions.
export type ModelImpl = 'cli' | 'sdk' | undefined;

// User config shape: matches `models.yaml` 1:1. Every field is optional
// except `mode` because the runtime only branches on `(mode, impl)` for
// dispatch — the strategy itself decides which other fields it needs and
// errors out if a required one is missing. This keeps the schema permissive
// at the type level while the strategy enforces its own preconditions.
export interface ModelAliasConfig {
  description?: string;
  mode: ModelMode;
  impl?: ModelImpl;
  // CLI binary path or PATH-resolved name (user-supplied — vendor identity
  // lives in user config, never in source). Example user config might set
  // `cli: claude` or `cli: gemini`; opensquid source treats it as opaque.
  cli?: string;
  args?: string[];
  sdk?: string;
  // User-supplied model id passed to the SDK/API path. Same discipline:
  // any vendor model name lives in user config, not in opensquid source.
  model?: string;
  endpoint?: string;
  provider?: string;
}

// Strategies expose a single async `call` method. `timeoutMs` is per-call
// override; strategies default to 30 s when undefined. The return is the
// raw model output as a string — classification / parsing is the caller's
// job (see `functions/llm.ts`).
export interface ModelStrategy {
  call(prompt: string, opts?: { timeoutMs?: number }): Promise<string>;
}
