/**
 * GS1 — resolve the CANONICAL task-checkpoint key (the work-graph issue id) for the current event, from
 * whichever context the deterministic stage fn (v2_supply) is running in.
 *
 * The canonical key is the `wg-…` issue id — the ONE value all three sides agree on (the interactive
 * create side, the lap trigger side, and the loop's scope gate). It is obtained WITHOUT inventing a reverse
 * map, using only the EXISTING forward `harness_map` (harness_task_id → wg_issue_id):
 *
 *   - LAP (OPENSQUID_ITEM_ID set) — the ralph loop publishes the wg issue id it is driving as
 *     `OPENSQUID_ITEM_ID` at spawn (ralph.ts). That IS the canonical key; return it directly (no I/O).
 *   - INTERACTIVE (no OPENSQUID_ITEM_ID) — the active task is a HARNESS task; resolve its harness id to the
 *     bound wg issue id via the forward `harness_map` (the SAME binding `harness_graph_sync` writes on the
 *     PreToolUse TaskCreate/TaskUpdate tick). The lookup keys on the harness task `id` (the map's key), NOT
 *     `readActiveTaskId`'s `taskId ?? id` — a `metadata.taskId` track id is never a map key.
 *
 * NULL-SKIP (the ordering fail-safe): when there is no active task, or the active harness task has NO wg
 * binding yet (it was not mirrored before this event), return `null`. The caller SKIPS the checkpoint write
 * for this event — a later deterministic event, once the binding exists, creates it. No key ⇒ no write ⇒
 * never a fabricated checkpoint. In practice the binding exists by scope time: `harness_graph_sync` fires on
 * the task's activating TaskUpdate tick (creating the wg issue + binding) BEFORE the subsequent scope-artifact
 * write, so the forward resolution normally succeeds during interactive scope.
 *
 * Imports from: node:path, ../paths.js, ../session_state.js, ./plan_evidence.js, ../../workgraph/harness_map.js.
 * Imported by: src/runtime/loop/v2_supply.ts (the single-writer checkpoint trigger + the FSM scope_write seed).
 */
import { join } from 'node:path';

import { resolveLocalStoreDir } from '../paths.js';
import { readActiveTask, readSessionCwd } from '../session_state.js';
import { resolveWgProject } from './plan_evidence.js';
import { harnessMapStore } from '../../workgraph/harness_map.js';

/** Injected seams (defaulted to the real readers) so the resolver is unit-testable without I/O. */
export interface CheckpointKeyDeps {
  /** The lap's published wg issue id, or undefined when not a lap (`process.env.OPENSQUID_ITEM_ID`). */
  itemId: () => string | undefined;
  /** The active harness task (its `.id` is the harness_map key), or null when no task is active. */
  readActiveTask: (sessionId: string) => Promise<{ id: string } | null>;
  /** The project namespace stamped in the `harness_map.db` rows (a harmless constant now the map is project-local). */
  resolveProject: (sessionId: string) => Promise<string>;
  /** Forward map: harness task id → bound wg issue id (null when unbound). `sessionId` selects the project-local store. */
  mapGet: (project: string, harnessId: string, sessionId: string) => Promise<string | null>;
}

const defaultDeps: CheckpointKeyDeps = {
  itemId: () => process.env.OPENSQUID_ITEM_ID,
  readActiveTask,
  resolveProject: resolveWgProject,
  // #26 HWS.1 (decision 5) — the binding overlay moved PROJECT-LOCAL. This reader MUST open the SAME
  // `<root>/.opensquid/harness_map.db` that `harness_graph_sync.ts`'s `defaultOpenMap` WRITES to (resolved by
  // the shared `resolveLocalStoreDir(cwd)`), or it would read a stale/empty GLOBAL map and null-skip every
  // interactive checkpoint. cwd is derived from the session, exactly as `defaultOpenMap`.
  mapGet: async (project, harnessId, sessionId) => {
    const cwd = (await readSessionCwd(sessionId)) ?? process.cwd();
    const dir = await resolveLocalStoreDir(cwd);
    const store = harnessMapStore(`file:${join(dir, 'harness_map.db')}`);
    await store.init();
    return store.get(project, harnessId);
  },
};

/**
 * Resolve the canonical task-checkpoint key (wg issue id) for `sessionId`, or `null` to SKIP the write.
 * See the module header for the lap vs interactive resolution + the null-skip ordering fail-safe.
 */
export async function resolveCheckpointKey(
  sessionId: string,
  deps: CheckpointKeyDeps = defaultDeps,
): Promise<string | null> {
  const item = deps.itemId();
  if (item !== undefined && item !== '') return item; // LAP: OPENSQUID_ITEM_ID IS the wg issue id
  const active = await deps.readActiveTask(sessionId);
  if (active === null) return null; // no active task → no key → skip the write
  const project = await deps.resolveProject(sessionId);
  return deps.mapGet(project, active.id, sessionId); // INTERACTIVE: forward-map harness id → wg id (null → skip)
}
