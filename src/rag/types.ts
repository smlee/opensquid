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

export interface RagBackend {
  init(): Promise<void>;
  embed(text: string): Promise<number[] | null>; // null = embedder unavailable
  recall(query: string, k: number): Promise<RecallHit[]>;
  storeLesson(lesson: Lesson): Promise<void>;
}
