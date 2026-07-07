/**
 * GS1 — the ralph loop's DURABLE per-item stage view, backed by the shared `task_checkpoints` table
 * (CheckpointStore) instead of the retired per-item sidecar files (`item_stage.ts`).
 *
 * The orchestrator drives a work-graph item by its CANONICAL id (the `wg-…` issue id). The v2 FSM's
 * deterministic stage fn is the SINGLE WRITER of the task checkpoint (keyed by that same canonical id via
 * `resolveCheckpointKey`); this module is the loop's READ side plus the ONE corrective write the gate is
 * allowed (resetting a bogus checkpoint to `scope`).
 *
 *   - `readLoopStage(wgId)`   → the item's recorded FSM stage (resume-correct), or null (fresh).
 *   - `clearLoopStage(wgId)`  → no-op: canonical wg ids are unique and a closed item leaves `listReady`, so a
 *                               lingering checkpoint row is harmless (the table is append-mostly, like
 *                               `run_manifests`); nothing to delete.
 *   - `scopeGate(wgId)`       → THE scope proof gate: never drive an item PAST scope without a real, on-disk
 *                               scope artifact.
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
 * Imported by: src/setup/cli/ralph.ts (readStage/clearStage/scopeGate wiring), src/runtime/loop/v2_supply.ts
 *   (withTaskCheckpointStore — the single-writer trigger + the FSM scope_write seed).
 */
import { access } from 'node:fs/promises';
import { join } from 'node:path';

import { createClient } from '@libsql/client';

import { resolveLocalStoreDir } from '../paths.js';
import { applyConcurrencyPragmas } from '../../storage/sqlite_concurrency.js';
import { CheckpointStore } from '../durable/checkpoint_store.js';
import { resolveCheckpointKey } from '../loop/checkpoint_key.js';

/** The interactive/human-only stage. A checkpoint parked here is BY DEFINITION out of automation — the scope
 *  gate never drives it; it awaits interactive human scope, which advances the checkpoint past `scope` and
 *  records the on-disk artifact (v2_supply's universal write-through), re-admitting it to automation. */
const SCOPE_STAGE = 'scope';

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
  fn: (store: CheckpointStore) => Promise<T>,
): Promise<T> {
  const client = createClient({ url: await checkpointDbUrl() });
  await applyConcurrencyPragmas(client);
  try {
    return await fn(new CheckpointStore(client));
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
 * The SINGLE task-checkpoint WRITE, as one owned method (was inlined in v2_supply's stage fn). Create the
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
 * THE SCOPE GATE (GS1). Automation MUST NEVER scope: an unscoped item is non-blocking — it is FIXED TO SCOPE
 * and pushed out of automation, and the loop advances to the next item. Reads the durable task checkpoint keyed
 * by the CANONICAL wg issue id and returns the item's automation-eligibility:
 *   - SCOPED (a checkpoint exists AND its stage is an automated stage — NOT `scope` — AND its recorded artifact
 *     paths are non-empty and ALL exist on disk) → 'drive'.
 *   - NOT scoped (no checkpoint, OR stage is the human-only `scope`, OR no/missing artifact) → FIX TO SCOPE:
 *     reset the checkpoint stage to `scope` (a no-op when no checkpoint exists) → 'hold'. The picker skips a
 *     held item (never re-picked → no spin); the item awaits interactive human scope, which advances its
 *     checkpoint past `scope` and records the artifact (v2_supply's universal write-through), re-admitting it.
 *   NB: this is NOT the old self-correcting reset — automation never re-scopes a held item; a reset to `scope`
 *   keeps it held every pass until a HUMAN scopes it interactively.
 * `exists` + `store` are injectable so the decision is unit-testable without the filesystem or a real db.
 */
export async function scopeGate(
  wgId: string,
  exists: (path: string) => Promise<boolean> = fileExists,
  store?: CheckpointStore,
): Promise<'drive' | 'hold'> {
  const decide = async (s: CheckpointStore): Promise<'drive' | 'hold'> => {
    const cp = await s.getTaskCheckpoint(wgId);
    // Automation-eligible ONLY when really scoped: a checkpoint past the human `scope` stage WITH on-disk proof.
    if (cp !== null && cp.stage !== SCOPE_STAGE) {
      const hasProof =
        cp.scopeArtifacts.length > 0 &&
        (await Promise.all(cp.scopeArtifacts.map((p) => exists(p)))).every(Boolean);
      if (hasProof) return 'drive';
    }
    // Not scoped → fix the checkpoint data to `scope` (UPDATE-only: a no-op when no checkpoint) and hold it out
    // of automation. updateTaskStage never CREATES — automation must not fabricate scope state for a fresh item.
    await s.updateTaskStage(wgId, SCOPE_STAGE, Date.now());
    return 'hold';
  };
  return store !== undefined ? decide(store) : withTaskCheckpointStore(decide);
}
