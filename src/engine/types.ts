/**
 * Wire-shape types for loop-engine JSON-RPC.
 *
 * Mirrors the shapes defined in engine/src/serve.rs at HEAD (engine v0.5.4).
 * Drift-corrected per T.1 audit findings (B, D, E, G):
 *   - LessonCreateParams gets v1.1 (`pack_id`, `seed_as_promoted`) +
 *     v1.2 (`external_id`) fields.
 *   - LessonCreateResult.authored_by output is `'user' | 'pack' | 'agent'`
 *     (not `'llm'` — engine renders Llm as `"agent"` on the wire per
 *     `authorship_str()` in serve.rs:830-836).
 *   - MemorySearchParams includes `mode: 'semantic' | 'text' | 'hybrid'`
 *     (engine does server-side RRF fusion in `'hybrid'` mode).
 *   - MemorySearchHit field is `similarity` (NOT `score`); `source` is
 *     optional and present only on hybrid results.
 *   - ManifestAssembleParams defaults `statuses` to `["active"]` which is
 *     unreachable via the public API per T.1.HH — opensquid MUST always
 *     pass an explicit `statuses: ["promoted"]` or `["pending","promoted"]`.
 *
 * No runtime code lives here — pure type module.
 */

/** MemoryScope wire shape (engine `MemoryScope` serde). */
export type MemoryScope =
  | 'user'
  | 'global'
  | { team: string }
  | { skill: string }
  | { project: string };

/** Scope filter for memory search/list (engine `ScopeFilterWire` serde). */
export type ScopeFilterWire =
  | { kind: 'exact'; scope: MemoryScope }
  | { kind: 'kind'; kind_name: 'user' | 'team' | 'skill' | 'project' | 'global' }
  | { kind: 'any_of'; scopes: MemoryScope[] };

/**
 * Memory provenance block. All fields optional; engine YAML omits absent
 * fields via `skip_serializing_if`, so partial blocks round-trip cleanly.
 *
 * Privacy: `session_id` is opaque (hashed first 8 chars); `cwd_basename`
 * is the last path segment only.
 */
export interface MemoryOrigin {
  host?: string;
  session_id?: string;
  model?: string;
  cwd_basename?: string;
  written_at?: string;
}

// ---- lesson.create ---------------------------------------------------

/**
 * Engine `LessonCreateParams` per serve.rs:317-344 (v1.1 + v1.2 surface).
 *
 * Validation rules enforced server-side:
 *  - `authored_by === 'pack'` AND missing/empty `pack_id` → -32602
 *  - `seed_as_promoted: true` AND `authored_by !== 'pack'` → -32602
 *
 * Wire INPUT: anything other than `'user' | 'pack'` for `authored_by`
 * silently maps to `Llm` (engine default).
 */
export interface LessonCreateParams {
  description: string;
  body: string;
  evidence?: string[];
  authored_by?: 'user' | 'pack';
  /** Required when `authored_by === 'pack'`. */
  pack_id?: string;
  /** v1.2 UPSERT lookup key; pack-authored only. */
  external_id?: string;
  /** v1.1 gate bypass; pack-authored only. */
  seed_as_promoted?: boolean;
}

/**
 * Engine `LessonCreateResult` per serve.rs:458-473.
 * Wire OUTPUT: `Llm → "agent"` (NOT `"llm"`).
 */
export interface LessonCreateResult {
  id: string;
  status: 'pending' | 'promoted';
  authored_by: 'user' | 'pack' | 'agent';
  pack_id?: string;
  external_id?: string;
  created_at: string;
  /** v1.2: true on UPSERT hit (existing row reused). */
  updated: boolean;
}

// ---- lesson.* misc ---------------------------------------------------

export interface LessonRecallHit {
  kind: 'lesson';
  id: string;
  description: string;
  status: string;
  body_preview: string;
  similarity: number;
  applied_count: number;
}

export interface LessonRecallResult {
  query: string;
  returned: number;
  results: LessonRecallHit[];
}

export interface LessonListRow {
  id: string;
  description: string;
  status: string;
  authored_by: string;
  pack_id: string | null;
  external_id: string | null;
  applied_count: number;
  thumbs_up_count: number;
  thumbs_down_count: number;
  created_at: string;
  updated_at: string | null;
}

export interface LessonListResult {
  total: number;
  limit: number;
  offset: number;
  returned: number;
  results: LessonListRow[];
}

// ---- memory.* --------------------------------------------------------

/**
 * Engine `MemorySearchParams` per serve.rs:935-967.
 *
 * `mode: 'hybrid'` is the load-bearing v0.5 addition — engine fuses
 * semantic + text via Cormack et al. 2009 RRF (k=60) SERVER-SIDE,
 * eliminating the need for a TS-side lexical leg (T.1.B + T.1.JJ).
 */
export interface MemorySearchParams {
  query: string;
  limit?: number;
  include_body?: boolean;
  scope_filter?: ScopeFilterWire;
  mode?: 'semantic' | 'text' | 'hybrid';
  /** Clamped to [0, 1] server-side. Applied to RAW scores BEFORE RRF merge. */
  min_similarity?: number;
}

export interface MemorySearchHit {
  kind: 'memory';
  id: string;
  description: string;
  /** 240-char preview by default; FULL body when `include_body: true`. */
  body_preview: string;
  /** Rounded to 3 decimals. Engine field is `similarity` — NOT `score`. */
  similarity: number;
  /** Present only in hybrid mode. */
  source?: 'semantic' | 'text' | 'both';
}

export interface MemorySearchResult {
  query: string;
  returned: number;
  results: MemorySearchHit[];
}

// ---- manifest.assemble -----------------------------------------------

/**
 * Engine `ManifestAssembleParams` per serve.rs:1363-1390.
 *
 * `statuses` default is `["active"]` — UNREACHABLE via public lesson API
 * (T.1.HH). Always pass `["promoted"]` or `["pending","promoted"]`.
 *
 * `record_applied` default is `true` — SIDE EFFECT: bumps `applied_count`
 * + `last_applied_at` per surfaced lesson. This is the path lessons
 * accumulate toward gate's `min_applied_count >= 3`. Pass `false` for
 * read-only callers.
 */
export interface ManifestAssembleParams {
  statuses?: ('pending' | 'active' | 'promoted' | 'superseded' | 'discarded')[];
  lesson_limit?: number;
  body_preview_len?: number;
  annotate_with_gate?: boolean;
  record_applied?: boolean;
  memory_query?: string;
  memory_limit?: number;
  memory_scope_filter?: ScopeFilterWire;
}

export interface ManifestActiveLesson {
  id: string;
  description: string;
  status: string;
  body_preview: string;
  applied_count: number;
  last_applied_at: string | null;
  target_skill: string | null;
  gate?: { kind: 'promote' | 'block'; reason_count: number };
}

export interface ManifestMemory {
  id: string;
  description: string;
  body_preview: string;
  similarity: number;
}

export interface ManifestAssembleResult {
  active_lessons: ManifestActiveLesson[];
  memories: ManifestMemory[];
  /** v1.4 returns empty arrays — deferred to a later engine release. */
  active_skills: unknown[];
  active_personas: unknown[];
  active_teams: unknown[];
  assembly_stats: {
    assembled_at: string;
    total_listed: number;
    skipped_count: number;
    gate_skip_count: number;
    record_applied_failures: number;
    memories_returned: number | null;
    memory_search_failures: number;
    session_section_skips: number;
  };
}

// ---- memory.* result shapes -----------------------------------------

export interface CreateMemoryResult {
  id: string;
  description: string;
  created_at: string;
  scope: MemoryScope;
  origin?: MemoryOrigin | null;
}

export interface GetMemoryResult {
  id: string;
  description: string;
  /** FULL body, no truncation. */
  content: string;
  created_at: string;
  scope: MemoryScope;
  origin?: MemoryOrigin | null;
  /**
   * Reverse-citation count enforcing user-immunity (T.1.E -32003).
   * A host MUST check this is `0` before force-deleting (force bypasses
   * the engine guard). Added to `memory.get` for CMP.4's per-predecessor
   * immunity gate.
   */
  consumed_by_user_lessons: number;
  /** Predecessor ids when this is a compressed memory; `[]` for raw. */
  derived_from: string[];
}

export interface MemoryListRow {
  id: string;
  description: string;
  scope: MemoryScope;
  origin: MemoryOrigin | null;
  created_at: string;
  updated_at: string | null;
  /** Reverse-citation count enforcing user-immunity (T.1.E -32003). */
  consumed_by_user_lessons: number;
}

export interface MemoryListResult {
  total: number;
  limit: number;
  offset: number;
  returned: number;
  results: MemoryListRow[];
}

// ---- task.* (phase ledger) ------------------------------------------

export interface TaskLogPhaseResult {
  ok: true;
  task_id: string;
  phase: string;
  newly_recorded: boolean;
}

export interface TaskGetLedgerResult {
  task_id: string;
  phases_logged: string[];
  entries: {
    phase: string;
    logged_at: string;
    note: string | null;
  }[];
}

// ---- lesson.* lifecycle result shapes --------------------------------

export interface LessonPromoteResult {
  ok: true;
  id: string;
  gate: 'passed';
  status: 'promoted';
  from: string;
  /**
   * Cited MEMORY ids from the promoted lesson's causal narrative (the
   * `EvidenceRef::Memory` evidence refs; quote refs excluded). The
   * compression-candidate collector (CMP.3) nominates these as
   * compression candidates. May be `[]` (a lesson with no memory
   * citations). Added in engine commit "lesson.promote returns
   * cited_memory_ids".
   */
  cited_memory_ids?: string[];
}

export interface LessonDiscardResult {
  ok: true;
  id: string;
  status: 'discarded';
  from: string;
  reason?: string;
}

export interface LessonCaptureFeedbackResult {
  ok: true;
  id: string;
  status: string;
  thumbs_up_count: number;
  thumbs_down_count: number;
  external_signal_sources: string[];
}

export interface LessonSupersedeResult {
  ok: true;
  old_id: string;
  new_id: string;
  old_status: string;
}

export interface MemoryUpdateResult {
  ok: true;
  id: string;
  description: string;
  created_at: string;
  updated_at: string;
  scope: MemoryScope;
  origin?: MemoryOrigin | null;
}

export interface MemoryDeleteResult {
  ok: true;
  id: string;
  forced: boolean;
}

// ---- memory.compress / memory.recompute_citations (CMP.1) -----------

/**
 * Engine `memory.compress` params per serve.rs `MemoryCompressParams`.
 *
 * `ids` is the explicit compression window — the host (which owns the
 * satisfaction probe + candidate collection) decides what to compress;
 * the engine never auto-selects. `max_tokens` / `temperature` default
 * to the engine's `CompressionConfig::default` when omitted.
 */
export interface CompressParams {
  ids: string[];
  max_tokens?: number;
  temperature?: number;
}

/**
 * Engine `memory.compress` result — the new compressed memory `Mc`.
 *
 * `derived_from` carries the predecessor ids (the trace the engine
 * chases via `get_by_id_chasing_derived_from` so recall still surfaces
 * `Mc` after predecessors are deleted). `consumed_by_user_lessons` is
 * the SUM across predecessors — `> 0` means the gist inherited a
 * user-lesson citation and the predecessors are user-immune.
 */
export interface CompressResult {
  id: string;
  description: string;
  derived_from: string[];
  consumed_by_user_lessons: number;
}

/**
 * Engine `memory.recompute_citations` result — drift stats from a
 * citation-counter recompute sweep. `counters_repaired > 0` means the
 * live state had drifted from ground truth; `orphan_citations > 0`
 * means a cited memory + its forward `derived_from` successors are all
 * gone (audit-trail integrity compromised — the host should investigate).
 */
export interface RecomputeCitationsResult {
  lessons_scanned: number;
  memories_recomputed: number;
  counters_repaired: number;
  orphan_citations: number;
}

// ---- memory.consolidate (CMP.4 — atomic safe-compression) -----------

/**
 * Engine `memory.consolidate` params per serve.rs
 * `MemoryConsolidateParams`.
 *
 * `ids` is the explicit window (the host decides what to consolidate).
 * `recall_k` is the recall-replay top-k the engine uses to VERIFY that
 * the minted `Mc` preserves each predecessor's recall before any
 * deletion; defaults to the engine's `DEFAULT_CONSOLIDATE_RECALL_K`.
 * `max_tokens` / `temperature` tune the internal compression step.
 */
export interface ConsolidateParams {
  ids: string[];
  max_tokens?: number;
  temperature?: number;
  recall_k?: number;
}

/**
 * Engine `memory.consolidate` result — the atomic verify+gated-delete
 * outcome. The engine GUARANTEES the D2 safety contract (verify +
 * immunity + fail-closed) internally; this is the report.
 *
 * - `mc_id`: the minted compressed memory. `null` only if compression
 *   itself failed (no `Mc` exists). Present even when `verified` is
 *   `false` — `Mc` then sits alongside the (undeleted) predecessors.
 * - `deleted`: predecessor ids force-deleted. Non-empty ONLY when
 *   `verified === true` (and excludes any user-cited predecessor).
 * - `kept_immune`: predecessors KEPT because they are user-cited
 *   (`consumed_by_user_lessons > 0`); the `derived_from` chain still
 *   links them to `Mc`.
 * - `verified`: the recall-replay gate passed for ALL predecessors AND
 *   compression succeeded. `false` ⇒ fail-closed (nothing deleted); the
 *   host surfaces a drift event.
 */
export interface ConsolidateResult {
  mc_id: string | null;
  deleted: string[];
  kept_immune: string[];
  verified: boolean;
}
