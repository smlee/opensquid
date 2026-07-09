/**
 * #26 — the PreToolUse wiring for the harness-task → work-graph sync (the impure shell).
 *
 * Reuses the `active_task_mirror` invocation seam: the hook calls {@link runHarnessGraphSync} right after
 * `mirrorActiveTask`, with the same `(sessionId, tool, args, transcriptPath)`. It is GATED to `TaskCreate`/
 * `TaskUpdate` ticks — a non-task tool never touches the work-graph (blast-radius: writes happen ONLY when the
 * harness task list actually changes). FAIL-OPEN: any error resolves to `null` (no instruction, no throw) so a
 * sync failure can never break the hook.
 *
 * The project is resolved via the SAME session→cwd→marker chain the loop + MCP use (`resolveWgProject` from
 * `plan_evidence.ts`), and the work-graph facade via the SAME opener (`openWg`) — so the autonomous loop and
 * the interactive session see one namespace. The binding overlay now lives PROJECT-LOCAL at
 * `<root>/.opensquid/harness_map.db` (HWS.1, CLOSED decision 5 — matching the project-local work-graph;
 * resolved by the SAME `resolveLocalStoreDir` opener; the work-graph store itself is untouched).
 *
 * BIDIRECTIONAL (HWS.5): each Task tick reconciles BOTH ways — the harness list → wg (the shipped inbound
 * half) AND the wg op-log cursor → harness (the outbound delta-set). The outbound is applied through the
 * injected {@link HarnessWriter} (default `ccNudgeWriter`): for CC that is an advisory nudge on the hook's
 * existing `additionalContext` path (create/status/close), since CC's transcript is read-only and its Task
 * tools agent-only. A shared monotonic high-water-mark (HWS.2 `sync_cursor`) makes the tick and the
 * orchestrator loop-pass reconcile safe to interleave (neither re-emits the other's ops).
 *
 * Imports from: node:path, ../paths.js, ../session_state.js, ../loop/plan_evidence.js,
 *   ./active_task_mirror.js, ./transcript_tasks.js, ./harness_writer.js, ../../workgraph/harness_map.js,
 *   ../../workgraph/harness_sync.js, ../../workgraph/types.js.
 * Imported by: src/runtime/hooks/pre-tool-use.ts.
 */
import { join } from 'node:path';

import { resolveLocalStoreDir } from '../paths.js';
import { readSessionCwd } from '../session_state.js';
import { openWg, resolveWgProject } from '../loop/plan_evidence.js';

import { readHarnessTasks } from './active_task_mirror.js';
import { readAllTasksFromTranscript, type PendingUpdate } from './transcript_tasks.js';
import { ccNudgeWriter, type HarnessWriter } from './harness_writer.js';

import { harnessMapStore } from '../../workgraph/harness_map.js';
import {
  reconcileHarnessWorkgraph,
  type HarnessMapReaderWriter,
  type HarnessTaskLike,
  type WgSyncFacade,
} from '../../workgraph/harness_sync.js';
import type { WgOp } from '../../workgraph/types.js';

/** The wg surface the bidirectional wiring needs: the reconcile write seam + the HWS.2 op-log cursor reads.
 *  The live `WorkGraphStore` (returned by `openWg`) satisfies it structurally; tests inject an in-memory stub. */
export interface WgReconcileFacade extends WgSyncFacade {
  listOpsSince(cursorLamport: number): Promise<WgOp[]>;
  readHighWater(): Promise<number>;
  advanceHighWater(lamport: number): Promise<void>;
}

/** Only these ticks materialize the work-graph — the blast-radius gate. */
const isTaskTick = (tool: string): boolean => tool === 'TaskCreate' || tool === 'TaskUpdate';

/**
 * Build the in-flight TaskUpdate overlay (H4a) from the pending args — same rule the mirror uses
 * (`active_task_mirror.ts`): a `TaskUpdate` with a status and/or metadata is overlaid so the read below sees
 * the transition THIS tick (PreToolUse fires pre-execution, so disk/transcript still lag). `TaskCreate`
 * carries no id at PreToolUse → no overlay.
 */
function buildPending(tool: string, args: Record<string, unknown>): PendingUpdate | undefined {
  if (tool !== 'TaskUpdate' || typeof args.taskId !== 'string') return undefined;
  const status = typeof args.status === 'string' ? args.status : undefined;
  const md =
    args.metadata !== null && typeof args.metadata === 'object'
      ? (args.metadata as Record<string, unknown>)
      : undefined;
  if (status === undefined && md === undefined) return undefined;
  return {
    taskId: args.taskId,
    ...(status !== undefined ? { status } : {}),
    ...(md !== undefined ? { metadata: md } : {}),
  };
}

/** The seams the wiring composes — injected in tests, defaulted to the real openers in production. */
export interface HarnessGraphSyncDeps {
  readTasks: (
    sessionId: string,
    transcriptPath: string | undefined,
    base: string | undefined,
    pending: PendingUpdate | undefined,
  ) => Promise<HarnessTaskLike[]>;
  resolveProject: (sessionId: string) => Promise<string>;
  openWg: (sessionId: string) => Promise<WgReconcileFacade>;
  // HWS.1 — the map opener is now cwd-derived (the store went project-local), so it takes `sessionId`.
  openMap: (sessionId: string) => Promise<HarnessMapReaderWriter>;
  // HWS.4 — the outbound writer seam (default `ccNudgeWriter`); a write-capable harness injects a real writer.
  writer: HarnessWriter;
}

/** Read the WHOLE task list from the transcript (this CC version) or the on-disk store (older CC), mirroring
 *  the dual-path source-selection of `mirrorActiveTask`. */
async function defaultReadTasks(
  sessionId: string,
  transcriptPath: string | undefined,
  base: string | undefined,
  pending: PendingUpdate | undefined,
): Promise<HarnessTaskLike[]> {
  if (transcriptPath !== undefined && transcriptPath.length > 0) {
    return readAllTasksFromTranscript(transcriptPath, pending);
  }
  return readHarnessTasks(sessionId, base);
}

/**
 * A fresh binding-overlay store at the PROJECT-LOCAL `<root>/.opensquid/harness_map.db` (HWS.1, CLOSED
 * decision 5 — the map moves project-local to match the now-project-local work-graph, resolved by the SAME
 * `resolveLocalStoreDir(cwd)` opener `openWg` uses). NO data migration: the old global
 * `~/.opensquid/harness_map.db` is intentionally ABANDONED in place; the project-local map re-binds on the
 * next tick, and the monotonic `bind` + the `isHarnessOwnedBody` echo-guard make re-materialization idempotent
 * (no duplicate issues). The hook subprocess is short-lived, so a fresh store per call (mirrors `openWg`).
 */
export async function defaultOpenMap(sessionId: string): Promise<HarnessMapReaderWriter> {
  const cwd = (await readSessionCwd(sessionId)) ?? process.cwd();
  const dir = await resolveLocalStoreDir(cwd);
  const store = harnessMapStore(`file:${join(dir, 'harness_map.db')}`);
  await store.init();
  return store;
}

const defaultDeps: HarnessGraphSyncDeps = {
  readTasks: defaultReadTasks,
  resolveProject: resolveWgProject,
  openWg,
  openMap: defaultOpenMap,
  writer: ccNudgeWriter,
};

/**
 * Sync the harness task list into the work-graph for this PreToolUse tick. Returns the outbound reconcile
 * instruction (or `null`) for the hook to inject. Gated to `TaskCreate`/`TaskUpdate`; fail-open on any error.
 */
export async function runHarnessGraphSync(
  sessionId: string,
  tool: string,
  args: Record<string, unknown>,
  transcriptPath?: string,
  base?: string,
  deps: HarnessGraphSyncDeps = defaultDeps,
): Promise<string | null> {
  if (!isTaskTick(tool)) return null; // blast-radius: only fire when the task list changed (gate FIRST)
  try {
    const pending = buildPending(tool, args);
    const tasks = await deps.readTasks(sessionId, transcriptPath, base, pending);
    if (tasks.length === 0) return null;
    const project = await deps.resolveProject(sessionId);
    const [wg, map] = await Promise.all([deps.openWg(sessionId), deps.openMap(sessionId)]);
    // HWS.5 — BIDIRECTIONAL: read the op-log cursor (HWS.2) alongside the harness task list and reconcile
    // BOTH ways (HWS.3). The outbound delta-set is applied via the injected writer (HWS.4, default the CC
    // nudge). The shared monotonic watermark advances AFTER a successful reconcile, only when there were ops.
    const cursor = await wg.readHighWater();
    const wgOps = await wg.listOpsSince(cursor);
    const result = await reconcileHarnessWorkgraph(project, tasks, wgOps, wg, map);
    const nudge = await deps.writer.apply(result.outbound);
    if (wgOps.length > 0) await wg.advanceHighWater(Math.max(...wgOps.map((o) => o.lamport)));
    return nudge; // rides additionalContext (unchanged)
  } catch {
    return null; // fail-open: a sync/reconcile/writer/cursor error must NEVER break the hook
  }
}
