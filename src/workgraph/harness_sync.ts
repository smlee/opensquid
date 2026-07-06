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
 * Imports from: (types only).
 * Imported by: src/runtime/hooks/harness_graph_sync.ts, src/workgraph/harness_sync.test.ts.
 */

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
  getIssue(id: string): Promise<{ id: string; status: string } | null>;
  updateIssue(id: string, patch: { status?: 'open' | 'closed' }): Promise<unknown>;
}

/** The binding surface the sync needs (a subset of {@link import('./harness_map.js').HarnessMapStore}). */
export interface HarnessMapReaderWriter {
  get(project: string, harnessId: string): Promise<string | null>;
  bind(project: string, harnessId: string, wgId: string): Promise<void>;
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
