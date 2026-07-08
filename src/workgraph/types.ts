/**
 * Work-graph types (T-WORKGRAPH-CORE, rewrite Phase 1 slice 1c) — the beads-style dependency
 * graph. `status` is `open|in_progress|closed` ONLY; "blocked" is NOT a stored status — it is
 * DERIVED from `blocks` edges (an open issue with an un-closed blocker is absent from
 * `listReady`). One source of truth (the edges) — no redundant/drift-prone state.
 *
 * Imported by: src/workgraph/store.ts.
 */
export type EdgeType = 'blocks' | 'parent-child' | 'discovered-from' | 'related';

// WGL.1 — `'archived'` is a SOFT, reversible, history-preserving terminal state (the row is KEPT, filtered
// off `listReady`; produced by the `issue_archived` op, reversed by `issue_unarchived`). NOT a hard-delete.
export type IssueStatus = 'open' | 'in_progress' | 'closed' | 'archived';

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
  // WGL.1 soft-archive reason — absent unless archived-with-reason (mirrors wedgeReason). Cleared on unarchive.
  archiveReason?: string;
}

/** Event-sourced op-log types (slice 1d). Ops are the source of truth; issues/edges are folded. */
export type WgOpType =
  | 'issue_created'
  | 'issue_set'
  | 'dep_added'
  | 'dep_removed'
  | 'issue_archived' // WGL.1 — soft-retire (a new op surviving replay; NOT a log rewrite)
  | 'issue_unarchived' // WGL.1 — reverse the soft-retire (reversible per §6.1)
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
 * The PROJECT-LOCAL work-graph store (T-project-local-state PLS.2). Each project's OpenSquid state lives
 * in its own `<root>/.opensquid/workgraph.db` (discovered by walking up from cwd like `git` finds `.git`),
 * so the store IS the project's — the ops take NO `project` key and reads filter on nothing. The
 * de-partitioned store adds only `init()` to the caller-facing {@link WorkGraphFacade} op surface; every
 * op signature is defined once, on the facade, so the partition cannot silently reappear on the IN path.
 * (The `project` column survives physically with a constant `'legacy-global'` stamp for schema back-compat
 * — see `workGraphStore` — but nothing FILTERS on it.) Spec: docs/tasks/T-project-local-state.md (PLS.2).
 */
export interface WorkGraphStore extends WorkGraphFacade {
  init(): Promise<void>;
}

/**
 * The caller-facing work-graph op surface — the project-less API every MCP handler / loop consumer calls.
 * Since T-project-local-state PLS.2 the store IS this surface (plus `init`); a {@link WorkGraphStore} is
 * structurally a `WorkGraphFacade`, so openers return the store directly (no `bindProject` binding step).
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
  // WGL.1 — soft-archive an issue to the reversible `archived` terminal state (records an optional reason);
  // `unarchiveIssue` restores it to `open`. History-preserving (a new op, surviving replay).
  archiveIssue(id: string, reason?: string): Promise<void>;
  unarchiveIssue(id: string): Promise<void>;
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
