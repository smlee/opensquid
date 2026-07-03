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
 * the interactive session see one namespace. The binding overlay lives in `~/.opensquid/harness_map.db`
 * (dedicated file; the work-graph store is untouched).
 *
 * OUTBOUND (write-back nudge): when a bound work-graph issue is `closed` but its harness task is still open,
 * this returns a one-line instruction telling the active agent to call `TaskUpdate(id, "completed")` — surfaced
 * via the hook's existing `additionalContext` injection path.
 *
 * Imports from: node:path, ../paths.js, ../loop/plan_evidence.js, ./active_task_mirror.js,
 *   ./transcript_tasks.js, ../../workgraph/harness_map.js, ../../workgraph/harness_sync.js.
 * Imported by: src/runtime/hooks/pre-tool-use.ts.
 */
import { join } from 'node:path';

import { OPENSQUID_HOME } from '../paths.js';
import { openWg, resolveWgProject } from '../loop/plan_evidence.js';

import { readHarnessTasks } from './active_task_mirror.js';
import { readAllTasksFromTranscript, type PendingUpdate } from './transcript_tasks.js';

import { harnessMapStore } from '../../workgraph/harness_map.js';
import {
  syncHarnessToWorkgraph,
  type HarnessMapReaderWriter,
  type HarnessTaskLike,
  type WgSyncFacade,
} from '../../workgraph/harness_sync.js';

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

/** The one-line reconcile nudge for work-graph issues that closed ahead of their still-open harness tasks. */
function buildInstruction(staleOpenHarnessIds: string[]): string | null {
  if (staleOpenHarnessIds.length === 0) return null;
  const list = staleOpenHarnessIds.map((id) => `#${id}`).join(', ');
  const plural = staleOpenHarnessIds.length > 1;
  return (
    `🦑 [workgraph sync] ${plural ? 'Tasks' : 'Task'} ${list} ${plural ? 'are' : 'is'} closed in the ` +
    `work-graph but still open in your task list — call TaskUpdate("<id>", "completed") ` +
    `${plural ? 'for each' : ''} to reconcile.`
  ).trim();
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
  openWg: (sessionId: string) => Promise<WgSyncFacade>;
  openMap: () => Promise<HarnessMapReaderWriter>;
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

/** A fresh binding-overlay store over `~/.opensquid/harness_map.db` (the hook subprocess is short-lived;
 *  OPENSQUID_HOME is test-isolated). Mirrors `openWg`'s fresh-store-per-call shape. */
async function defaultOpenMap(): Promise<HarnessMapReaderWriter> {
  const store = harnessMapStore(`file:${join(OPENSQUID_HOME(), 'harness_map.db')}`);
  await store.init();
  return store;
}

const defaultDeps: HarnessGraphSyncDeps = {
  readTasks: defaultReadTasks,
  resolveProject: resolveWgProject,
  openWg,
  openMap: defaultOpenMap,
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
  if (!isTaskTick(tool)) return null; // blast-radius: only fire when the task list changed
  try {
    const pending = buildPending(tool, args);
    const tasks = await deps.readTasks(sessionId, transcriptPath, base, pending);
    if (tasks.length === 0) return null;
    const project = await deps.resolveProject(sessionId);
    const [wg, map] = await Promise.all([deps.openWg(sessionId), deps.openMap()]);
    const result = await syncHarnessToWorkgraph(project, tasks, wg, map);
    return buildInstruction(result.staleOpenHarnessIds);
  } catch {
    return null; // fail-open: a sync error must NEVER break the hook
  }
}
