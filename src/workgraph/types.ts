/**
 * Work-graph types (T-WORKGRAPH-CORE, rewrite Phase 1 slice 1c) — the beads-style dependency
 * graph. `status` is `open|in_progress|closed` ONLY; "blocked" is NOT a stored status — it is
 * DERIVED from `blocks` edges (an open issue with an un-closed blocker is absent from
 * `listReady`). One source of truth (the edges) — no redundant/drift-prone state.
 *
 * Imported by: src/workgraph/store.ts.
 */
export type EdgeType = 'blocks' | 'parent-child' | 'discovered-from' | 'related';

export type IssueStatus = 'open' | 'in_progress' | 'closed';

export interface Issue {
  id: string;
  title: string;
  body: string;
  status: IssueStatus;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

/** Event-sourced op-log types (slice 1d). Ops are the source of truth; issues/edges are folded. */
export type WgOpType = 'issue_created' | 'issue_set' | 'dep_added' | 'dep_removed';

export interface WgOp {
  id: string;
  issueId: string; // subject issue (for dep ops: the `from` issue; full edge in payload)
  lamport: number;
  type: WgOpType;
  payload: Record<string, unknown>;
}

export interface WorkGraphStore {
  init(): Promise<void>;
  createIssue(input: { title: string; body?: string }): Promise<Issue>;
  getIssue(id: string): Promise<Issue | null>;
  listIssues(filter?: { status?: IssueStatus }): Promise<Issue[]>;
  updateIssue(
    id: string,
    patch: { status?: IssueStatus; title?: string; body?: string },
  ): Promise<Issue>;
  addEdge(fromId: string, toId: string, type: EdgeType): Promise<void>;
  /** Open issues with no un-closed `blocks` blocker, oldest-first (a deterministic queue). */
  listReady(): Promise<Issue[]>;
  /** The append-only op-log for an issue, in (lamport, id) order. */
  listEvents(issueId: string): Promise<WgOp[]>;
}
