/**
 * The per-track scope-state keys that must clear when a NEW track begins (the
 * `scope_start` re-arm, packs/builtin/coding-flow/fsm.yaml:52). Single source of
 * truth — add a future per-track key HERE and both the renderer's artifact read
 * (src/runtime/handoff/collect.ts) and the re-arm reset (the
 * `reset_scope_track_state` primitive) stay in sync, so the reset enumeration can
 * never drift across files (wg-4c48ef1b9969).
 *
 * DELIBERATELY EXCLUDED (do NOT add — each excluded for a distinct reason):
 *  - `coding-flow-track`            — has its own re-arm reset (→ 'feature', the strict default).
 *  - `coding-flow-guess-audit-cache`/`-spec-audit-cache` — content-hashed; new content → cache
 *                                      miss, so staleness is self-correcting. Blanket-wiping them
 *                                      just discards valid cache.
 *  - `coding-flow-scope-dwell`      — self-resets on scope-region exit (scope_dwell.ts).
 */
export const SCOPE_TRACK_STATE_KEYS = [
  'coding-flow-pre-research-path',
  'coding-flow-spec-path',
  'coding-flow-design',
] as const;
