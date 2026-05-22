/**
 * Wire-shape types for loop-engine JSON-RPC.
 *
 * Mirrors the shapes defined in engine/src/serve.rs at HEAD (engine v0.5.3).
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
