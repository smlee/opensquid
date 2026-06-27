/**
 * T2.9 — the AF.3 EXECUTE loop driver.
 *
 * On `phases_complete` for a task, the driver does TWO things deterministically (zero LLM):
 *   1. emits the per-task CODE stage report (AF.3) via `emitStageReport` (stage 'CODE') — the named live
 *      caller of the CODE report (stage_report.ts notes CODE is owned by THIS module, not v2_supply).
 *   2. computes the NEXT run-group from the work-graph via `batchDecide` (T2.14) and returns it, so the
 *      caller (the FSM driver, T2.1/T2.15) can dispatch the next group and the loop advances autonomously.
 *
 * The work-graph is injected as a minimal interface (`LoopWorkGraph`), NOT the concrete store, so the driver
 * is decoupled + trivially testable. The concrete `WorkGraphStore` (src/workgraph/store.ts) exposes
 * `listReady(project)` → `Issue[]` and `listEdges(project)` → `{from,to,type}[]`; a caller adapts it to this
 * interface (project-bound + `Issue[]` → `id[]`):
 *
 *   const wg: LoopWorkGraph = {
 *     listReadyIds: async () => (await store.listReady(project)).map((i) => i.id),
 *     listEdges:    () => store.listEdges(project),
 *   };
 *
 * No live caller yet: T2.9 ships the skill + this driver module + tests. The FSM `phases_complete` →
 * `onPhasesComplete` wiring (the dispatch of the returned run-group) is T2.1/T2.15's job — the driver is the
 * exported fn those tasks call, exactly as stage_report.ts (CODE) anticipates.
 *
 * Imports from: ./batch_decide, ./stage_report.
 * Imported by: (deferred) T2.1/T2.15 FSM driver + its test.
 */
import { batchDecide, type Edge } from './batch_decide.js';
import { CODE_PHASES, emitStageReport } from './stage_report.js';

/**
 * The minimal work-graph view the driver needs — injectable so the driver never touches the concrete store.
 * `listReadyIds` is the ready-issue ids (open, unblocked, unclaimed); `listEdges` is the folded edge triples.
 */
export interface LoopWorkGraph {
  listReadyIds(): Promise<string[]>;
  listEdges(): Promise<Edge[]>;
}

/**
 * On `phases_complete`: emit the CODE stage report + return the next run-group from `batchDecide`.
 *
 * The returned `next` is a list of run-groups: a multi-issue group is a sibling BATCH (run together),
 * a singleton group is an independent issue. When `batchDecide` found no batches, every parallel issue
 * becomes its own singleton group (`parallel.map((i) => [i])`).
 */
export async function onPhasesComplete(
  sid: string,
  root: string,
  taskId: string,
  wg: LoopWorkGraph,
  iso: string,
): Promise<{ next: string[][]; report: string }> {
  // sid threads through for symmetry with the FSM caller (T2.1) which keys session-scoped state by it; the
  // CODE report itself is a per-project artifact (no sessionId in emitStageReport's signature — see its JSDoc).
  void sid;
  // The CODE report is the long, stand-out one: it carries the 7-phase coding-cycle chart. At
  // `phases_complete` the gate has confirmed all 7 ran, so every box is checked. `report.body` is
  // returned so the (deferred T2.1/T2.15) live caller can SHOW it in-session + chat, exactly as
  // v2_supply does for the other stages.
  const { body } = await emitStageReport(
    root,
    {
      stage: 'CODE',
      taskId,
      summary: 'all 7 coding phases logged + readiness surfacers ran',
      nextDirective: 'deploy',
      phases: CODE_PHASES.map((name) => ({ name, done: true })),
    },
    iso,
  );
  const { parallel, batches } = batchDecide(await wg.listReadyIds(), await wg.listEdges());
  return { next: batches.length ? batches : parallel.map((i) => [i]), report: body };
}
