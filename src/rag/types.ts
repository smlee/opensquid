/**
 * RAG types: `Lesson`, `RecallHit`, `RagBackend`.
 *
 * The `RagBackend` interface is the ONLY surface that `src/functions/rag.ts`
 * sees — no `@libsql/client` types leak past this boundary. That is what
 * makes the backend pluggable: Task 1.11 lands `libsql-lexical`, Task 1.12
 * lands `claude-auto-memory`, and neither requires touching the primitives.
 *
 * `embed()` returns `Promise<number[] | null>` rather than throwing on
 * embedder-down because the backend treats Ollama-absent as a degraded
 * (lexical-only) mode, not an error. The primitive caller decides what to
 * do with `null` — by default, `store_lesson` still inserts the row.
 *
 * Imports from: nothing (leaf type module).
 * Imported by: src/rag/* + src/functions/rag.ts.
 */

export interface Lesson {
  id: string;
  content: string;
  tags: string[];
  source: string;
  author: 'user' | 'agent';
  createdAt: string; // ISO 8601
  // Compression columns (memory store only): default [] / 0 when absent. Carried on the base type so
  // the per-file source + rebuild preserve a consolidated memory's trace (see compress.ts MemoryRow).
  derivedFrom?: string[];
  consumedByUserLessons?: number;
  // Scope (T-memory-scope-isolation): `shared` memories cross every project; `project` memories are
  // namespaced to an umbrella id. Absent ⇒ `shared` / null namespace (back-compat with pre-scope rows).
  tier?: MemoryTier;
  namespace?: string | null;
  // Retention (wg-9e4f4eb2a40f): ISO timestamp set when consolidation DEMOTES this predecessor. A
  // retired memory stays queryable by id (the rollback floor + replay oracle) but is EXCLUDED from
  // the injectable recall surface. Absent ⇒ live. Slice 3's sweeper hard-deletes after 30 quiet days.
  retired_at?: string;
  // Durability axis (wg-4f91e0b5cb8c): `point_in_time` memories assert a fact bound to a moment/
  // session/version that becomes false once acted on (handoff/resume/status/version snapshots); they
  // are subject to recency decay at recall (SCI.2) + supersession/age retirement (SCI.3). `durable`
  // (the default when absent ⇒ back-compat) memories are decay-immune. Classified ONCE at write time
  // by `classifyDurability` (durability.ts). No existing field encodes this — `author` spans both
  // classes (a user-authored handoff is point-in-time), so it needs its own axis.
  durability?: Durability;
}

/** A memory's durability class. Absent ⇒ `durable`. See `Lesson.durability` + `classifyDurability`. */
export type Durability = 'durable' | 'point_in_time';

/**
 * A memory's scope tier. `shared` crosses every project (user/global knowledge); `project` is isolated
 * to one umbrella `namespace`. Kept to exactly two grounded values — every write path can produce both
 * (memorize enum-maps, the importer resolves the umbrella). See T-memory-scope-isolation.
 */
export type MemoryTier = 'shared' | 'project';

/** The required recall scope: the caller's resolved umbrella namespace (null = no project context). */
export interface RecallScope {
  namespace: string | null;
}

/**
 * The PURE eligibility predicate — the one place the cross/isolate rule lives, so it is unit-testable and
 * cannot drift. A hit is eligible iff it is `shared`, OR it is `project` AND its namespace matches the
 * recall scope. A null recall namespace (no project context) therefore matches ONLY `shared` rows
 * (fail-closed: project memory is never leaked when the project is unknown). Absent tier ⇒ `shared`.
 */
export function inScope(
  tier: MemoryTier | undefined,
  namespace: string | null | undefined,
  scope: RecallScope,
): boolean {
  if ((tier ?? 'shared') === 'shared') return true;
  return namespace != null && namespace === scope.namespace;
}

export interface RecallHit {
  lesson: Lesson;
  score: number;
  source: 'semantic' | 'lexical' | 'fused';
}

/** Result of `deleteLesson`. `deleted:false` = id not found (caller maps to INVALID_PARAMS). */
export interface DeleteResult {
  deleted: boolean;
  forced: boolean;
}

/**
 * Thrown by `deleteLesson` when the target is a `user`-authored lesson and `force` was not set.
 * Defined here (not in mcp/tools) so every backend can throw it without depending on the MCP layer
 * (`forget.ts` re-exports it for back-compat with existing imports). Mirrors the engine's
 * USER_MEMORY_IMMUNE (-32003) — explicit user deletion is allowed (with force); automatic eviction
 * of user memories is forbidden (the no-auto-delete invariant).
 */
export class UserAuthoredImmunityError extends Error {
  constructor(public readonly id: string) {
    super(`Memory ${id} is user-authored and eviction-immune. Pass force: true to delete.`);
    this.name = 'UserAuthoredImmunityError';
  }
}

export interface RagBackend {
  init(): Promise<void>;
  embed(text: string): Promise<number[] | null>; // null = embedder unavailable
  // `scope` is REQUIRED (no default): the structural firewall. A future rewrite that forgets to thread
  // scope is a COMPILE error, not a silent cross-project leak (the exact regression this fixes).
  recall(query: string, k: number, scope: RecallScope): Promise<RecallHit[]>;
  storeLesson(lesson: Lesson): Promise<void>;
  // Explicit-only deletion (the no-auto-delete invariant): user-authored lessons require force.
  deleteLesson(id: string, opts?: { force?: boolean }): Promise<DeleteResult>;
  // Demote (retire) a memory: leaves it queryable by id (rollback floor) but OUT of the injectable
  // recall surface (wg-9e4f4eb2a40f). OPTIONAL — only consolidation-capable backends implement it.
  demoteLesson?(id: string): Promise<void>;
}
