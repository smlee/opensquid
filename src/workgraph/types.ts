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
  project: string; // T-WORKGRAPH-PROJECT-SCOPE: namespace ('legacy-global' for legacy/un-scoped ops)
  // WGD.1 — the op-log replica id (per-HOME UUID); the `actor-id` half of the `(lamport, actor-id)`
  // tuple that orders + content-addresses ops. Optional on the wire; replay defaults a missing one to
  // 'legacy' (legacy op-files predate this field).
  actorId?: string;
}

/**
 * The project-scoped store. ONE instance (one client, one global Lamport clock) backs every project;
 * `project` is threaded as the first arg of each method so reads filter and writes stamp it. Handlers do
 * NOT call this directly — they call a per-project {@link WorkGraphFacade} (which binds `project`).
 * Spec: docs/tasks/T-workgraph-project-scope.md.
 */
export interface WorkGraphStore {
  init(): Promise<void>;
  createIssue(project: string, input: { title: string; body?: string }): Promise<Issue>;
  getIssue(project: string, id: string): Promise<Issue | null>;
  listIssues(project: string, filter?: { status?: IssueStatus }): Promise<Issue[]>;
  updateIssue(
    project: string,
    id: string,
    patch: { status?: IssueStatus; title?: string; body?: string },
  ): Promise<Issue>;
  addEdge(project: string, fromId: string, toId: string, type: EdgeType): Promise<void>;
  /** Open issues with no un-closed `blocks` blocker AND no live claim, oldest-first. */
  listReady(project: string): Promise<Issue[]>;
  /**
   * Atomically claim an item for `ttlSec` (exactly-once CAS via a unique claim token). Returns
   * `won:true` only for the single winner; concurrent/duplicate claims get `won:false`. An item
   * whose prior claim has expired is claimable again (query-time staleness). (GR.1.)
   */
  claimIssue(
    project: string,
    id: string,
    audience: ClaimAudience,
    ttlSec: number,
  ): Promise<{ won: boolean; expiresAt: string }>;
  /**
   * Mark an item as wedged (GR.3): a re-attempt SKIPS it (it's escalated, not retried) so the
   * supervisor can't crash-loop the same wall. Excluded from `listReady` until the reason is cleared.
   */
  wedgeMark(project: string, id: string, reason: string): Promise<void>;
  /** Clear a wedge-mark (GR.4 human-override resolution): `wedge_reason` → null → the item re-enters
   * `listReady` for another lap. The residual-shrink path's un-wedge. */
  clearWedge(project: string, id: string): Promise<void>;
  releaseClaim(project: string, id: string): Promise<void>;
  /** The append-only op-log for an issue, in (lamport, id) order. */
  listEvents(project: string, issueId: string): Promise<WgOp[]>;
  /**
   * T2.5 — the folded edge projection for a project, as `{from,to,type}` triples (deterministic order by
   * `edge_key`). Mirrors {@link listIssues}; the PLAN gate (`planAudit`) reads the dependency graph through it.
   */
  listEdges(project: string): Promise<{ from: string; to: string; type: EdgeType }[]>;
}

/**
 * A per-project view over the single {@link WorkGraphStore}: the SAME methods minus the leading `project`
 * arg (it's bound by `bindProject`). This is what `getWorkGraph()` returns, so the MCP handlers keep their
 * existing call signatures while operating on one project.
 */
export interface WorkGraphFacade {
  createIssue(input: { title: string; body?: string }): Promise<Issue>;
  getIssue(id: string): Promise<Issue | null>;
  listIssues(filter?: { status?: IssueStatus }): Promise<Issue[]>;
  updateIssue(
    id: string,
    patch: { status?: IssueStatus; title?: string; body?: string },
  ): Promise<Issue>;
  addEdge(fromId: string, toId: string, type: EdgeType): Promise<void>;
  listReady(): Promise<Issue[]>;
  claimIssue(
    id: string,
    audience: ClaimAudience,
    ttlSec: number,
  ): Promise<{ won: boolean; expiresAt: string }>;
  wedgeMark(id: string, reason: string): Promise<void>;
  clearWedge(id: string): Promise<void>;
  releaseClaim(id: string): Promise<void>;
  listEvents(issueId: string): Promise<WgOp[]>;
  /** T2.5 — the project's folded edge projection as `{from,to,type}` triples (deterministic). */
  listEdges(): Promise<{ from: string; to: string; type: EdgeType }[]>;
}
