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

/**
 * Who claimed an item, derived at claim time from the GDC env markers the gate already trusts
 * (`AGENT_ENV_MARKERS` — CLAUDECODE / CODEX_THREAD_ID / AI_AGENT). Informational; the exactly-once
 * guarantee comes from the claim token, not this field. (GR.1 of the gated-ralph loop.)
 */
export interface ClaimAudience {
  source: 'claudecode' | 'codex' | 'unknown';
  threadId?: string; // CODEX_THREAD_ID when codex
  version?: string; // CLAUDECODE value when claude
}

export interface Issue {
  id: string;
  title: string;
  body: string;
  status: IssueStatus;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  // GR.1 claim fields — absent/undefined when unclaimed. A claim with claimExpiresAt <= now is
  // treated as unclaimed (query-time expiry; no reaper).
  claimToken?: string; // unique per claim attempt — the CAS winner's token
  claimAudience?: ClaimAudience;
  claimExpiresAt?: string; // ISO 8601
  // GR.3 wedge-mark — a re-attempt SKIPS a wedge-marked item (escalate, don't crash-loop the wall).
  wedgeReason?: string;
}

/** Event-sourced op-log types (slice 1d). Ops are the source of truth; issues/edges are folded. */
export type WgOpType =
  | 'issue_created'
  | 'issue_set'
  | 'dep_added'
  | 'dep_removed'
  | 'claim_acquired'
  | 'wedge_marked'
  | 'wedge_cleared'
  | 'claim_released';

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
  /** Open issues with no un-closed `blocks` blocker AND no live claim, oldest-first. */
  listReady(): Promise<Issue[]>;
  /**
   * Atomically claim an item for `ttlSec` (exactly-once CAS via a unique claim token). Returns
   * `won:true` only for the single winner; concurrent/duplicate claims get `won:false`. An item
   * whose prior claim has expired is claimable again (query-time staleness). (GR.1.)
   */
  claimIssue(
    id: string,
    audience: ClaimAudience,
    ttlSec: number,
  ): Promise<{ won: boolean; expiresAt: string }>;
  /**
   * Mark an item as wedged (GR.3): a re-attempt SKIPS it (it's escalated, not retried) so the
   * supervisor can't crash-loop the same wall. Excluded from `listReady` until the reason is cleared.
   */
  wedgeMark(id: string, reason: string): Promise<void>;
  /** Clear a wedge-mark (GR.4 human-override resolution): `wedge_reason` → null → the item re-enters
   * `listReady` for another lap. The residual-shrink path's un-wedge. */
  clearWedge(id: string): Promise<void>;
  releaseClaim(id: string): Promise<void>;
  /** The append-only op-log for an issue, in (lamport, id) order. */
  listEvents(issueId: string): Promise<WgOp[]>;
}
