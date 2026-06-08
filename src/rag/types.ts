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
  recall(query: string, k: number): Promise<RecallHit[]>;
  storeLesson(lesson: Lesson): Promise<void>;
  // Explicit-only deletion (the no-auto-delete invariant): user-authored lessons require force.
  deleteLesson(id: string, opts?: { force?: boolean }): Promise<DeleteResult>;
}
