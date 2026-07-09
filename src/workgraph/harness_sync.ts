/**
 * #26 — materialize the harness task list into the work-graph (the pure core).
 *
 * DIRECTION: the harness task list is AUTHORITATIVE; the work-graph is a materialized VIEW. For each harness
 * task this projects its state onto a work-graph issue via the injected {@link HarnessMapStore} binding:
 *
 *   unmapped + open (pending/in_progress) → createIssue({title: subject, body: provenance}) + bind
 *   unmapped + terminal (completed/deleted) → SKIP (nothing to open; the task finished before we ever saw it)
 *   mapped + wg already `closed`            → SKIP (MONOTONIC-CLOSED — a closed issue is NEVER resurrected)
 *   mapped + otherwise                      → updateIssue(status) iff it changes (pending/in_progress→open,
 *                                             completed/deleted→closed)
 *
 * IDEMPOTENT: running twice over unchanged input creates nothing and updates nothing (every write is guarded
 * by "does it differ from the current state"). PURE over injected deps (a work-graph facade + the map store),
 * so it is exhaustively unit-testable with in-memory stubs — no I/O, no clock, no globals.
 *
 * Imports from: ./types.js (WgOp, type-only).
 * Imported by: src/runtime/hooks/harness_graph_sync.ts, src/workgraph/harness_sync.test.ts.
 */
import type { WgOp } from './types.js';

/** The harness task shape the sync reads — structurally the `HarnessTask` of `active_task_mirror.ts` and the
 *  full-task rows of `transcript_tasks.ts` (same `{id, subject, status, metadata?}`). */
export interface HarnessTaskLike {
  id: string;
  subject: string;
  status: string; // pending | in_progress | completed | deleted
  metadata?: { taskId?: string; spec?: string };
}

/** The minimal work-graph WRITE surface the sync needs (a subset of `WorkGraphFacade`, `workgraph/types.ts`).
 *  INJECTED, so the sync never imports the store internals — the live caller passes the project-bound facade. */
export interface WgSyncFacade {
  createIssue(input: { title: string; body?: string }): Promise<{ id: string }>;
  // HWS.3 — `getIssue` now also exposes `title` (for a `create` outbound delta) and `body` (for the
  // echo-guard `isHarnessOwnedBody`). The live `WorkGraphStore` already returns the full `Issue`, so this
  // widen is type-only; every in-memory test stub gains the two fields.
  getIssue(id: string): Promise<{ id: string; status: string; title: string; body: string } | null>;
  updateIssue(id: string, patch: { status?: 'open' | 'closed' }): Promise<unknown>;
}

/** The binding surface the sync needs (a subset of {@link import('./harness_map.js').HarnessMapStore}). */
export interface HarnessMapReaderWriter {
  get(project: string, harnessId: string): Promise<string | null>;
  bind(project: string, harnessId: string, wgId: string): Promise<void>;
  /** HWS.1 — the reverse resolve wg → harness (the outbound reconcile's binding lookup; `null` ⇒ `create`). */
  getByWgId(project: string, wgId: string): Promise<string | null>;
}

const HARNESS_OPEN = new Set(['pending', 'in_progress']);
const HARNESS_CLOSED = new Set(['completed', 'deleted']);

/** Map a harness status onto a work-graph status, or `null` for an unrecognized status (→ skip, never guess). */
function mapStatus(harnessStatus: string): 'open' | 'closed' | null {
  if (HARNESS_OPEN.has(harnessStatus)) return 'open';
  if (HARNESS_CLOSED.has(harnessStatus)) return 'closed';
  return null;
}

/** The provenance stamp `syncHarnessToWorkgraph` writes as the FIRST line of every materialized mirror issue's
 *  body (`harness-task:<id>`). The single source of truth for the format — both the writer ({@link provenanceBody})
 *  and any reader ({@link isHarnessOwnedBody}) derive from it, so the stamp can never drift between them. */
export const HARNESS_TASK_STAMP = 'harness-task:';

/** True iff `body` carries the sync's provenance stamp — i.e. the issue is a materialized harness-task-list mirror
 *  (as opposed to a hand-authored backlog issue). Line-scoped so it matches the stamp wherever it sits in the body,
 *  never a substring inside prose. The ralph loop uses this to drive the SYNCED task-list mirror items first. */
export function isHarnessOwnedBody(body: string): boolean {
  return body.split('\n').some((line) => line.startsWith(HARNESS_TASK_STAMP));
}

/** The work-graph issue body: harness provenance so a materialized issue is traceable back to its task. */
function provenanceBody(t: HarnessTaskLike): string {
  const parts = [`${HARNESS_TASK_STAMP}${t.id}`];
  if (t.metadata?.taskId !== undefined && t.metadata.taskId !== '')
    parts.push(`task-spec:${t.metadata.taskId}`);
  if (t.metadata?.spec !== undefined && t.metadata.spec !== '')
    parts.push(`spec:${t.metadata.spec}`);
  return parts.join('\n');
}

export interface SyncResult {
  /** harness ids for which a new work-graph issue was created + bound this run. */
  created: string[];
  /** work-graph ids whose status was updated this run. */
  updated: string[];
  /** work-graph ids that were already `closed` (skipped — monotonic-closed). */
  skippedClosed: string[];
  /** harness ids whose bound work-graph issue is `closed` while the task is still OPEN — the reconciler emits
   *  a `TaskUpdate(id, "completed")` instruction for each (the outbound write-back nudge). */
  staleOpenHarnessIds: string[];
}

/**
 * Materialize `tasks` into the work-graph for `project`. See the module header for the per-task rules.
 * Pure over `wg` + `map`; returns a {@link SyncResult} the caller uses for the outbound reconcile instruction.
 */
export async function syncHarnessToWorkgraph(
  project: string,
  tasks: HarnessTaskLike[],
  wg: WgSyncFacade,
  map: HarnessMapReaderWriter,
): Promise<SyncResult> {
  const result: SyncResult = {
    created: [],
    updated: [],
    skippedClosed: [],
    staleOpenHarnessIds: [],
  };

  for (const t of tasks) {
    const target = mapStatus(t.status);
    if (target === null) continue; // unrecognized harness status → skip (never guess a mapping)

    const existing = await map.get(project, t.id);

    if (existing === null) {
      // Unmapped. Create+bind ONLY for an OPEN task; a terminal-and-unmapped task (completed/deleted, never
      // materialized) is skipped — there is nothing to open, and creating-then-closing would be churn.
      if (target === 'open') {
        const title = t.subject.trim() !== '' ? t.subject : `harness task ${t.id}`;
        const issue = await wg.createIssue({ title, body: provenanceBody(t) });
        await map.bind(project, t.id, issue.id);
        result.created.push(t.id);
      }
      continue;
    }

    // Mapped: reconcile the bound work-graph issue.
    const issue = await wg.getIssue(existing);
    if (issue === null) continue; // the bound issue is gone (rebuild/prune) → skip, no throw

    if (issue.status === 'closed') {
      // MONOTONIC-CLOSED: a closed work-graph issue is NEVER re-opened, even if the harness task re-opens.
      result.skippedClosed.push(existing);
      // Outbound: wg is done but the harness task is still open → the human/agent should mark it completed.
      if (target === 'open') result.staleOpenHarnessIds.push(t.id);
      continue;
    }

    // wg is open/in_progress: apply the target status only when it actually changes something (idempotent).
    if (issue.status !== target) {
      await wg.updateIssue(existing, { status: target });
      result.updated.push(existing);
    }
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// HWS.3 — the OUTBOUND half + bidirectional reconcile.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The wg → harness outbound delta — STATUS + EXISTENCE ONLY (decision 6: a flat harness list cannot model
 * edges / claims / wedge, so those are NEVER emitted). Each names the harness id (or, for a `create`, the wg
 * id + title) so the {@link import('../runtime/hooks/harness_writer.js').HarnessWriter} can render/apply it.
 */
export type OutboundDelta =
  | { kind: 'create'; wgId: string; title: string } // a wg issue with no bound harness task
  | { kind: 'status'; harnessId: string; status: 'closed' } // a bound task whose wg went terminal
  | { kind: 'close'; harnessId: string }; // stale-closed (generalizes staleOpenHarnessIds)

/** The two-way reconcile result: the shipped inbound {@link SyncResult} + the outbound delta-set. */
export interface ReconcileResult extends SyncResult {
  /** The status+existence delta-set the {@link HarnessWriter} renders/applies (decision 6). */
  outbound: OutboundDelta[];
}

/** wg terminal states (from the harness's view): both `closed` and the soft-`archived` retire the task. */
function isWgTerminal(status: string): boolean {
  return status === 'closed' || status === 'archived';
}

/** Only these op types carry EXISTENCE / STATUS semantics — the reconcile ignores structure ops (dep_*,
 *  claim_*, wedge_*) so decision 6 (structure never outbound) holds by construction, not by after-filter. */
const EXISTENCE_OPS: ReadonlySet<WgOp['type']> = new Set([
  'issue_created',
  'issue_set',
  'issue_archived',
  'issue_unarchived',
]);

/** Distinct subject issue ids of the existence/status ops in `wgOps`, first-seen order (structure ops omitted). */
function existenceIssueIds(wgOps: WgOp[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const op of wgOps) {
    if (!EXISTENCE_OPS.has(op.type)) continue; // structure op → never an outbound delta (decision 6)
    if (seen.has(op.issueId)) continue;
    seen.add(op.issueId);
    out.push(op.issueId);
  }
  return out;
}

/**
 * The TWO-WAY reconcile: the shipped inbound half ({@link syncHarnessToWorkgraph}, harness → wg) COMPOSED with
 * the outbound half (wg → harness delta-set), resolving each field by its authority (decisions 2/4/6):
 *
 *   - status ← harness      — the inbound half projects harness status onto the issue (unchanged).
 *   - structure ← workgraph — edges / claims / wedge are NEVER emitted outbound (structure ops are filtered
 *                             out of the candidate set; decision 6).
 *   - title/body ← LWW      — the op-log already applied LWW-by-lamport inbound (`events.ts` `issue_set`
 *                             guarded `WHERE lww <= ?`); the OUTBOUND is status+existence only, so a title/body
 *                             op produces NO delta (the wg value stands, the harness value is lamport-less).
 *   - monotonic-closed      — kept: a `closed` wg issue is never reopened; its still-open task emits a `close`.
 *
 * Echo-guarded: an op whose issue body {@link isHarnessOwnedBody} is a harness-materialized MIRROR — pushing a
 * delta for it would push back the very change the harness just pushed in (an infinite sync loop), so it is
 * suppressed. PURE: `wg` / `map` are injected seams and `wgOps` / `tasks` are data — no clock, no globals; a
 * rerun over unchanged input yields an empty outbound set (idempotent).
 */
export async function reconcileHarnessWorkgraph(
  project: string,
  tasks: HarnessTaskLike[],
  wgOps: WgOp[],
  wg: WgSyncFacade,
  map: HarnessMapReaderWriter,
): Promise<ReconcileResult> {
  const inbound = await syncHarnessToWorkgraph(project, tasks, wg, map); // shipped inbound half, unchanged
  const outbound: OutboundDelta[] = [];
  const emittedHarness = new Set<string>(); // dedupe: a harness id gets at most one existence/status delta

  // Stale-closed → a `close` existence delta (generalizes inbound.staleOpenHarnessIds: task open, bound wg closed).
  for (const hId of inbound.staleOpenHarnessIds) {
    if (emittedHarness.has(hId)) continue;
    emittedHarness.add(hId);
    outbound.push({ kind: 'close', harnessId: hId });
  }

  // wg-originated existence/status ops (from the cursor) → create/status deltas, echo-guarded + reverse-resolved.
  for (const issueId of existenceIssueIds(wgOps)) {
    const issue = await wg.getIssue(issueId);
    if (issue === null) continue; // the issue is gone (rebuild/prune) → nothing to mirror
    if (isHarnessOwnedBody(issue.body)) continue; // echo-guard: a harness-materialized mirror → no push-back
    const harnessId = await map.getByWgId(project, issueId); // HWS.1 reverse index
    if (harnessId === null) {
      // No bound harness task. Mirror it as a NEW task ONLY when it is still live — creating-then-closing a
      // wg issue that is already terminal is churn (mirrors the inbound "terminal-and-unmapped → skip").
      if (!isWgTerminal(issue.status))
        outbound.push({ kind: 'create', wgId: issueId, title: issue.title });
      continue;
    }
    // Bound: emit a status delta only when the wg issue went terminal while the task may still be open.
    if (isWgTerminal(issue.status) && !emittedHarness.has(harnessId)) {
      emittedHarness.add(harnessId);
      outbound.push({ kind: 'status', harnessId, status: 'closed' });
    }
    // title/body: outbound is status+existence only (decision 6) → no delta; the wg value stands (LWW inbound).
  }

  return { ...inbound, outbound };
}
