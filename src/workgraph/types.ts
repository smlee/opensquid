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

/** An append-only work-graph event (the audit/versioning log). */
export interface WgEvent {
  id: number;
  issueId: string;
  ts: string; // ISO 8601
  kind: string; // created | status_changed | updated | …
  data: Record<string, unknown>;
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
  /** The append-only event log for an issue, oldest-first. */
  listEvents(issueId: string): Promise<WgEvent[]>;
}
