/**
 * GS1 — the ralph loop's DURABLE per-item stage view, backed by the shared `task_checkpoints` table
 * (CheckpointStore) instead of the retired per-item sidecar files (`item_stage.ts`).
 *
 * The coordinator drives a work-graph item by canonical id and is the sole durable writer for automated stage
 * progression. Interactive human transitions use this same seam to establish the initial handoff. State ids are
 * opaque.
 *
 *   - `readLoopStage(wgId)`      → recorded state id, or null.
 *   - `clearLoopStage(wgId)`     → no-op for the append-mostly checkpoint table.
 *   - `automationAdmission(...)` → drive only a pack-declared process state with its durable handoff proof.
 *
 * Every read/write opens a short-lived CheckpointStore client to the PROJECT-LOCAL `<root>/.opensquid/opensquid.db`
 * (resolved by walking up from cwd for the nearest `.opensquid/`, git-`.git` style; T-project-local-state PLS.3)
 * with the shared WAL + busy_timeout posture (`applyConcurrencyPragmas`) so it never trips `SQLITE_BUSY` against
 * the daemon / a concurrent lap. `withTaskCheckpointStore` is exported for the FSM write-through (v2_supply) to
 * reuse the SAME opener + posture. This is a TABLE split: the checkpoint + loop tables are project-local; the
 * daemon `audit_log` + RAG/recall stay GLOBAL (design §4 OUT).
 *
 * Imports from: node:fs/promises, @libsql/client, ../paths.js, ../../storage/sqlite_concurrency.js,
 *   ../durable/checkpoint_store.js.
 * Imported by the outer coordinator and the interactive handoff projection.
 */
import { access } from 'node:fs/promises';
import { join } from 'node:path';

import { createClient, type Client } from '@libsql/client';

import { resolveLocalStoreDir } from '../paths.js';
import { applyConcurrencyPragmas } from '../../storage/sqlite_concurrency.js';
import { CheckpointStore } from '../durable/checkpoint_store.js';
import { resolveCheckpointKey } from '../loop/checkpoint_key.js';
import { ensureLoopEventSchema, readScopeHandoffByItem } from '../loop/loop_events.js';
import { installScopeHandoffStoreInvariants } from '../loop/scope_handoff_store.js';
import { emitMonitorEvent } from '../loop/monitor_emit.js';

/** The PROJECT-LOCAL opensquid.db url the task checkpoint lives in: `<root>/.opensquid/opensquid.db`, resolved
 *  by walking up from cwd for the nearest `.opensquid/` (honors the `OPENSQUID_PROJECT_ROOT` test override).
 *  THROWS when run outside a project store — an IN opener never falls back to the global home (that fallback is
 *  the partition PLS removes). The daemon `audit_log` + RAG stay GLOBAL; this is a TABLE split, not a file move. */
async function checkpointDbUrl(): Promise<string> {
  return `file:${join(await resolveLocalStoreDir(process.cwd()), 'opensquid.db')}`;
}

/**
 * Open a short-lived CheckpointStore against `opensquid.db` with the shared WAL + busy_timeout posture, run
 * `fn`, and ALWAYS close the client. The posture is AWAITED (not fire-and-forget) so `busy_timeout` is in
 * force before the first read/write. Shared by this module and the v2-supply single-writer trigger.
 */
export async function withTaskCheckpointStore<T>(
  fn: (store: CheckpointStore, client: Client, url: string) => Promise<T>,
): Promise<T> {
  const url = await checkpointDbUrl();
  const client = createClient({ url });
  await applyConcurrencyPragmas(client);
  try {
    return await fn(new CheckpointStore(client), client, url);
  } finally {
    try {
      client.close();
    } catch {
      /* already closed / close error — nothing actionable */
    }
  }
}

/** The item's recorded FSM stage (resume-correct), or null when it has no checkpoint yet (a fresh item). */
export async function readLoopStage(wgId: string): Promise<string | null> {
  return withTaskCheckpointStore(
    async (store) => (await store.getTaskCheckpoint(wgId))?.stage ?? null,
  );
}

/** True iff the item already has a durable checkpoint (it is NOT fresh). The FSM seed uses this to restart an
 *  automated lap past the pack initial (resume) rather than re-running from the top. */
export async function taskCheckpointExists(wgId: string): Promise<boolean> {
  return withTaskCheckpointStore(async (store) => (await store.getTaskCheckpoint(wgId)) !== null);
}

/**
 * Read the PACK-AGNOSTIC task checkpoint for a SESSION — resolves the session → its canonical wg issue id
 * (`resolveCheckpointKey`), then reads the durable stage + scope-artifact paths. Returns null when the
 * session has no bound checkpoint (no active/bound task, no lap item). This is the pack-neutral resume
 * source handoff should read instead of guessing pack-named session keys (`fsm-<pack>` / `<pack>-*-path`),
 * which drift when the active pack changes (coding-flow → fullstack-flow).
 */
export async function readCheckpointBySession(
  sessionId: string,
): Promise<{ stage: string; scopeArtifacts: string[] } | null> {
  const wgId = await resolveCheckpointKey(sessionId);
  if (wgId === null) return null;
  return withTaskCheckpointStore((store) => store.getTaskCheckpoint(wgId));
}

/**
 * The single task-checkpoint write seam. Create the
 * checkpoint if absent, else update its stage; and when a scope artifact is stamped, record it as the on-disk
 * scope proof (set AFTER create so the row exists). Keyed by the canonical wg issue id. Callers pass the
 * artifact (or null) so this module owns the write orchestration, not the FSM supply layer.
 */
export async function upsertTaskStage(
  wgId: string,
  stage: string,
  nowMs: number,
  artifact: string | null = null,
): Promise<void> {
  await withTaskCheckpointStore(async (store) => {
    const existing = await store.getTaskCheckpoint(wgId);
    if (existing === null) await store.createTaskCheckpoint(wgId, stage, nowMs);
    else await store.updateTaskStage(wgId, stage, nowMs);
    if (artifact !== null) await store.setTaskArtifacts(wgId, [artifact], nowMs);
  });
  // LMP.2 — PUSH the stage advance to the live monitor stream, AFTER the durable checkpoint write. Fail-open:
  // `emitMonitorEvent` swallows a store fault so a monitor-feed hiccup never breaks the load-bearing advance.
  // The generic stage-granular feed stamps the pack's opaque id verbatim. Optional sub-phase events are a
  // separate layer and never determine whether a state appears in the monitor.
  await emitMonitorEvent({ wgId, kind: 'stage_advance', stage, atMs: nowMs });
}

/** No-op (see module header): a closed item leaves `listReady`; a lingering checkpoint row is harmless. */
export async function clearLoopStage(_wgId: string): Promise<void> {
  /* intentionally empty — the append-mostly checkpoint table needs no per-item teardown */
}

/** Default on-disk existence check (injectable for tests). True iff the path is accessible. */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pack-neutral automation admission. A checkpoint is driveable only when its opaque state id belongs to the
 * active pack's declared process set and its one durable handoff artifact still exists with a matching semantic
 * receipt. Failure holds the item without rewriting its checkpoint; core cannot infer a corrective state.
 */
export async function automationAdmission(
  wgId: string,
  isAutomated: (stageId: string) => boolean,
  exists: (path: string) => Promise<boolean> = fileExists,
  store?: CheckpointStore,
  hasReceipt?: (artifactPath: string) => Promise<boolean>,
): Promise<'drive' | 'hold'> {
  const decide = async (
    s: CheckpointStore,
    receiptFor: (artifactPath: string) => Promise<boolean>,
  ): Promise<'drive' | 'hold'> => {
    const checkpoint = await s.getTaskCheckpoint(wgId);
    if (
      checkpoint !== null &&
      isAutomated(checkpoint.stage) &&
      checkpoint.scopeArtifacts.length === 1
    ) {
      const artifact = checkpoint.scopeArtifacts[0]!;
      if ((await exists(artifact)) && (await receiptFor(artifact))) return 'drive';
    }
    return 'hold';
  };
  if (store !== undefined) {
    return decide(store, hasReceipt ?? (() => Promise.resolve(false)));
  }
  return withTaskCheckpointStore(async (s, client, url) => {
    await s.init();
    await ensureLoopEventSchema(client, url);
    await installScopeHandoffStoreInvariants(client);
    return decide(s, async (artifactPath) => {
      try {
        const receipt = await readScopeHandoffByItem(client, wgId);
        return receipt !== null && receipt.artifactPath === artifactPath;
      } catch {
        return false;
      }
    });
  });
}
