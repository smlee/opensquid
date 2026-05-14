/**
 * Public types for OpenSquid v0.1.
 *
 * On-disk format mirrors `loop-engine`'s `LessonFrontmatter` shape
 * (status-as-directory invariant; `authored_by` is load-bearing for
 * the wedge immunity rule). Once loop-engine ships an IPC surface
 * we swap the storage layer; the types stay.
 */

export type LessonStatus =
  | "pending"
  | "active"
  | "promoted"
  | "discarded"
  | "superseded";

export type Authorship = "user" | "agent";

export interface Lesson {
  /** `les-` prefix + 8 hex chars. Stable across status transitions. */
  id: string;
  /** Short summary — what the agent claims to have learned. */
  description: string;
  /** Full lesson narrative. Markdown allowed. */
  body: string;
  /**
   * Citations grounding the lesson. Free-form strings (quotes) OR
   * `mem-xxxxxxxx` memory references. At least one entry required
   * for the gate to pass.
   */
  evidence: string[];
  status: LessonStatus;
  /** ISO-8601 timestamp. */
  createdAt: string;
  updatedAt?: string;
  /**
   * Who authored this lesson. `user` = explicit human endorsement;
   * `agent` = LLM-generated. User-authored lessons are eviction-
   * immune from engine-initiated discard (the wedge invariant).
   */
  authoredBy: Authorship;
  thumbsUp: number;
  thumbsDown: number;
  /** When `eliminate` was called. Set only on `discarded` lessons. */
  discardedAt?: string;
  discardReason?: string;
}

/** Reasons the wedge gate refused promotion. */
export type BlockReason =
  | { kind: "missing-body"; detail: string }
  | { kind: "missing-evidence"; detail: string }
  | { kind: "thumbs-down-block"; detail: string }
  | { kind: "time-floor"; detail: string }
  | { kind: "already-terminal"; detail: string };

export interface GateDecision {
  promote: boolean;
  reasons: BlockReason[];
}

/** What `recall` returns to the host LLM. */
export interface LessonRef {
  id: string;
  description: string;
  status: LessonStatus;
  bodyPreview: string;
  similarity: number; // 0..1
}
