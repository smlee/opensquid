import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

import { createClient, type Client } from '@libsql/client';

import { readActiveDocsRootStrict } from '../../packs/discovery.js';
import { loadActiveV2Cartridges } from '../bootstrap.js';
import { workGraphStore } from '../../workgraph/store.js';
import type { Issue } from '../../workgraph/types.js';
import { applyConcurrencyPragmas } from '../../storage/sqlite_concurrency.js';
import { CheckpointStore, type TaskCheckpoint } from '../durable/checkpoint_store.js';
import {
  ensureLoopEventSchema,
  insertScopeHandoffReceipt,
  readLegacyAutomationEntrySeqs,
  readScopeHandoffByAction,
  readScopeHandoffByItem,
  scopeHandoffActionId,
  type ScopeHandoffReceipt,
} from '../loop/loop_events.js';
import { installScopeHandoffStoreInvariants } from '../loop/scope_handoff_store.js';
import { writeStatuslineSnapshot } from '../loop/statusline_snapshot.js';
import { resolveActorId } from '../actor_id.js';
import { resolveLocalStoreDir } from '../paths.js';
import {
  ensureLoopRunning,
  resolveLoopProject,
  type LoopAutoSpawnResult,
} from './loop_autospawn.js';

const MAX_SCOPE_ARTIFACT_BYTES = 16 * 1024 * 1024;
const SCOPE_HASH_CHUNK_BYTES = 64 * 1024;

export type ScopeHandoffErrorCode = 'validation' | 'conflict' | 'stale' | 'persistence';
export type ScopeHandoffTransition = 'entered' | 'reused' | 'repaired';
export type ScopeEvidenceKind = 'approval' | 'legacy_repair';

export class ScopeHandoffError extends Error {
  readonly name = 'ScopeHandoffError';

  constructor(
    readonly code: ScopeHandoffErrorCode,
    readonly wgId: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface ResolvedScopeContext {
  readonly invocationCwd: string;
  readonly targetRepoRoot: string;
  readonly storeRoot: string;
  readonly docsRoot: string;
  readonly opensquidDbUrl: string;
}

export interface CompleteScopeResult {
  readonly kind: 'scope_handoff';
  readonly wgId: string;
  readonly artifact: string;
  readonly artifactSha256: string;
  readonly evidenceKind: ScopeEvidenceKind;
  readonly actionId: string;
  readonly transition: ScopeHandoffTransition;
  readonly checkpointStage: string;
  readonly loop: LoopAutoSpawnResult;
}

export interface ScopeHandoffPolicy {
  readonly initialStage: string;
  readonly entryStage: string;
  readonly repairStages: ReadonlySet<string>;
}

export interface CompleteScopeDeps {
  readonly loadIssue?: (context: ResolvedScopeContext, wgId: string) => Promise<Issue | null>;
  readonly loadPolicy?: (context: ResolvedScopeContext) => Promise<ScopeHandoffPolicy>;
  readonly ensureLoop?: (targetRepoRoot: string) => Promise<LoopAutoSpawnResult>;
  readonly refreshProjection?: (targetRepoRoot: string) => Promise<void>;
  readonly createDbClient?: (url: string) => Client;
  readonly nowMs?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

async function strictDocsRoot(
  storeRoot: string,
  projectRoot: string,
  wgId: string,
): Promise<string> {
  let configured: string;
  try {
    configured = await readActiveDocsRootStrict(storeRoot);
  } catch (error) {
    throw new ScopeHandoffError(
      'validation',
      wgId,
      `scope-done cannot read strict docsRoot policy at ${join(storeRoot, 'active.json')}`,
      { cause: error },
    );
  }

  let canonical: string;
  try {
    canonical = await realpath(resolve(projectRoot, configured));
    if (!(await stat(canonical)).isDirectory()) {
      throw new Error('configured path is not a directory');
    }
  } catch (error) {
    throw new ScopeHandoffError(
      'validation',
      wgId,
      `scope-done configured docsRoot is unavailable: ${configured}`,
      { cause: error },
    );
  }
  return canonical;
}

export async function resolveScopeContext(
  cwd: string,
  wgId: string,
): Promise<ResolvedScopeContext> {
  let invocationCwd: string;
  try {
    invocationCwd = await realpath(cwd);
  } catch (error) {
    throw new ScopeHandoffError('validation', wgId, `scope-done cwd is unavailable: ${cwd}`, {
      cause: error,
    });
  }
  let storeRoot: string;
  try {
    storeRoot = await realpath(await resolveLocalStoreDir(invocationCwd));
  } catch (error) {
    throw new ScopeHandoffError(
      'validation',
      wgId,
      `scope-done could not resolve the selected project from ${invocationCwd}`,
      { cause: error },
    );
  }
  const targetRepoRoot = dirname(storeRoot);
  try {
    await resolveLoopProject(targetRepoRoot);
  } catch (error) {
    throw new ScopeHandoffError(
      'validation',
      wgId,
      'scope-done selected store has no exact owner',
      {
        cause: error,
      },
    );
  }
  const docsRoot = await strictDocsRoot(storeRoot, targetRepoRoot, wgId);
  return {
    invocationCwd,
    targetRepoRoot,
    storeRoot,
    docsRoot,
    opensquidDbUrl: `file:${join(storeRoot, 'opensquid.db')}`,
  };
}

async function validateArtifact(
  context: ResolvedScopeContext,
  inputPath: string,
  wgId: string,
): Promise<{ path: string; sha256: string }> {
  let path: string;
  try {
    path = await realpath(resolve(context.invocationCwd, inputPath));
  } catch (error) {
    throw new ScopeHandoffError('validation', wgId, `scope artifact is unavailable: ${inputPath}`, {
      cause: error,
    });
  }
  if (path !== context.docsRoot && !path.startsWith(`${context.docsRoot}${sep}`)) {
    throw new ScopeHandoffError(
      'validation',
      wgId,
      `scope artifact is outside configured docsRoot: ${inputPath}`,
    );
  }

  // Hash the same descriptor whose identity is validated. The second path observation catches an intermediate
  // directory/symlink swap; dev+ino catches replacement at the same canonical pathname. Once opened, later
  // renames cannot redirect the bytes read from this descriptor.
  const flags =
    process.platform === 'win32'
      ? fsConstants.O_RDONLY
      : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, flags);
    const descriptorStat = await handle.stat();
    if (!descriptorStat.isFile()) throw new Error('artifact is not a regular file');
    if (descriptorStat.size > MAX_SCOPE_ARTIFACT_BYTES) {
      throw new Error(`artifact exceeds ${String(MAX_SCOPE_ARTIFACT_BYTES)} bytes`);
    }
    const [observedPath, pathStat] = await Promise.all([realpath(path), stat(path)]);
    if (
      observedPath !== path ||
      descriptorStat.dev !== pathStat.dev ||
      descriptorStat.ino !== pathStat.ino
    ) {
      throw new Error('artifact path changed during validation');
    }
    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(SCOPE_HASH_CHUNK_BYTES);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_SCOPE_ARTIFACT_BYTES) {
        throw new Error(`artifact exceeds ${String(MAX_SCOPE_ARTIFACT_BYTES)} bytes`);
      }
      hash.update(chunk.subarray(0, bytesRead));
    }
    return { path, sha256: hash.digest('hex') };
  } catch (error) {
    throw new ScopeHandoffError('validation', wgId, `scope artifact is unavailable: ${inputPath}`, {
      cause: error,
    });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function defaultLoadPolicy(context: ResolvedScopeContext): Promise<ScopeHandoffPolicy> {
  const candidates = (
    await loadActiveV2Cartridges('<scope-handoff>', context.targetRepoRoot)
  ).filter(
    (loaded) => loaded.compiled.automation !== undefined && loaded.compiled.fsm !== undefined,
  );
  if (candidates.length !== 1) {
    throw new Error(
      `scope handoff requires exactly one active automated pack; found ${String(candidates.length)}`,
    );
  }
  const loaded = candidates[0]!;
  const automation = loaded.compiled.automation!;
  const fsm = loaded.compiled.fsm!;
  return {
    initialStage: fsm.initial,
    entryStage: automation.entry,
    repairStages: new Set(
      fsm.states.filter((stageId) => loaded.compiled.meta[stageId]?.kind !== 'terminal'),
    ),
  };
}

async function defaultLoadIssue(
  context: ResolvedScopeContext,
  wgId: string,
): Promise<Issue | null> {
  const store = workGraphStore({
    dbUrl: `file:${join(context.storeRoot, 'workgraph.db')}`,
    sourceDir: join(context.storeRoot, 'store', 'issues'),
    actorId: await resolveActorId(),
  });
  await store.init();
  return store.getIssue(wgId);
}

function checkpointPath(cp: TaskCheckpoint): string | null {
  return cp.scopeArtifacts.length === 1 ? cp.scopeArtifacts[0]! : null;
}

function assertReusableCheckpoint(
  cp: TaskCheckpoint | null,
  canonicalArtifact: string,
  wgId: string,
  policy: ScopeHandoffPolicy,
): TaskCheckpoint {
  if (
    cp === null ||
    !policy.repairStages.has(cp.stage) ||
    cp.stage === policy.initialStage ||
    checkpointPath(cp) !== canonicalArtifact
  ) {
    throw new ScopeHandoffError(
      'conflict',
      wgId,
      'scope handoff receipt conflicts with the current checkpoint',
    );
  }
  return cp;
}

interface PersistedClassification {
  transition: ScopeHandoffTransition;
  checkpointStage: string;
  receipt: Omit<ScopeHandoffReceipt, 'seq'>;
}

async function persistHandoff(
  client: Client,
  context: ResolvedScopeContext,
  input: {
    wgId: string;
    artifact: string;
    artifactSha256: string;
    actionId: string;
    nowMs: number;
    policy: ScopeHandoffPolicy;
  },
): Promise<PersistedClassification> {
  const schemaStore = new CheckpointStore(client);
  await schemaStore.init();
  await ensureLoopEventSchema(client, context.opensquidDbUrl);
  await installScopeHandoffStoreInvariants(client);

  const tx = await client.transaction('write');
  try {
    const store = new CheckpointStore(tx, true);
    const cp = await store.getTaskCheckpoint(input.wgId);
    const byItem = await readScopeHandoffByItem(tx, input.wgId);
    const byAction = await readScopeHandoffByAction(tx, input.actionId);
    const legacySeqs = await readLegacyAutomationEntrySeqs(tx, input.wgId, input.policy.entryStage);

    if (byItem !== null) {
      if (
        byItem.actionId !== input.actionId ||
        byItem.artifactPath !== input.artifact ||
        byAction?.wgId !== input.wgId
      ) {
        throw new ScopeHandoffError(
          'conflict',
          input.wgId,
          'scope handoff already exists for a different artifact',
        );
      }
      const current = assertReusableCheckpoint(cp, input.artifact, input.wgId, input.policy);
      await tx.commit();
      return {
        transition: 'reused',
        checkpointStage: current.stage,
        receipt: byItem,
      };
    }
    if (byAction !== null) {
      throw new ScopeHandoffError(
        'conflict',
        input.wgId,
        'scope handoff action identity collides with another item',
      );
    }

    let transition: ScopeHandoffTransition;
    let checkpointStage: string;
    let evidenceKind: ScopeEvidenceKind;
    if (cp === null || cp.stage === input.policy.initialStage) {
      if (legacySeqs.length > 0) {
        throw new ScopeHandoffError(
          'conflict',
          input.wgId,
          'legacy automation-entry history has no matching eligible checkpoint',
        );
      }
      if (cp !== null && cp.scopeArtifacts.length > 0 && checkpointPath(cp) !== input.artifact) {
        throw new ScopeHandoffError(
          'conflict',
          input.wgId,
          'scope checkpoint already references a different artifact',
        );
      }
      transition = 'entered';
      checkpointStage = input.policy.entryStage;
      evidenceKind = 'approval';
    } else {
      const current = assertReusableCheckpoint(cp, input.artifact, input.wgId, input.policy);
      transition = 'repaired';
      checkpointStage = current.stage;
      evidenceKind = 'legacy_repair';
    }

    const receipt = {
      wgId: input.wgId,
      actionId: input.actionId,
      stage: checkpointStage,
      artifactPath: input.artifact,
      artifactSha256: input.artifactSha256,
      evidenceKind,
    } satisfies Omit<ScopeHandoffReceipt, 'seq'>;
    // Receipt first in the same transaction: no approved-artifact checkpoint becomes visible without authority.
    // Rollback removes both records on any later fault.
    await insertScopeHandoffReceipt(tx, { ...receipt, atMs: input.nowMs });
    if (transition === 'entered') {
      if (cp === null) {
        await store.createTaskCheckpoint(input.wgId, input.policy.entryStage, input.nowMs, [
          input.artifact,
        ]);
      } else {
        await store.updateTaskStage(input.wgId, input.policy.entryStage, input.nowMs, [
          input.artifact,
        ]);
      }
    }
    await tx.commit();
    return { transition, checkpointStage, receipt };
  } catch (error) {
    if (!tx.closed) await tx.rollback().catch(() => undefined);
    throw error;
  } finally {
    tx.close();
  }
}

async function reconcileLoopLiveness(
  targetRepoRoot: string,
  ensureLoop: (targetRepoRoot: string) => Promise<LoopAutoSpawnResult>,
  sleep: (ms: number) => Promise<void>,
): Promise<LoopAutoSpawnResult> {
  const delays = [0, 250, 1_000] as const;
  let last: LoopAutoSpawnResult = { status: 'error', error: 'loop reconciliation did not run' };
  for (const delay of delays) {
    if (delay > 0) await sleep(delay);
    last = await ensureLoop(targetRepoRoot);
    if (last.status !== 'error') return last;
  }
  return last;
}

/** Human scope-exit boundary shared by CLI, Pi, and future TUI/web actions. */
export async function completeInteractiveScope(
  input: {
    wgId: string;
    artifact: string;
    cwd: string;
  },
  deps: CompleteScopeDeps = {},
): Promise<CompleteScopeResult> {
  const context = await resolveScopeContext(input.cwd, input.wgId);
  const [artifact, policy] = await Promise.all([
    validateArtifact(context, input.artifact, input.wgId),
    (deps.loadPolicy ?? defaultLoadPolicy)(context),
  ]);
  const issue = await (deps.loadIssue ?? defaultLoadIssue)(context, input.wgId);
  if (issue?.status !== 'open') {
    throw new ScopeHandoffError(
      'stale',
      input.wgId,
      `scope-done requires an open WorkGraph item: ${input.wgId}`,
    );
  }
  const canonicalWgId = issue.id;
  const actionId = scopeHandoffActionId(canonicalWgId, artifact.path);
  const client = (deps.createDbClient ?? ((url) => createClient({ url })))(context.opensquidDbUrl);
  await applyConcurrencyPragmas(client);

  let persisted: PersistedClassification;
  try {
    persisted = await persistHandoff(client, context, {
      wgId: canonicalWgId,
      artifact: artifact.path,
      artifactSha256: artifact.sha256,
      actionId,
      nowMs: (deps.nowMs ?? Date.now)(),
      policy,
    });
  } catch (error) {
    if (error instanceof ScopeHandoffError) throw error;
    throw new ScopeHandoffError(
      'persistence',
      canonicalWgId,
      `scope handoff persistence failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    client.close();
  }

  await (deps.refreshProjection ?? ((root) => writeStatuslineSnapshot(root)))(
    context.targetRepoRoot,
  ).catch(() => undefined);
  const loop = await reconcileLoopLiveness(
    context.targetRepoRoot,
    deps.ensureLoop ?? ensureLoopRunning,
    deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  );
  return {
    kind: 'scope_handoff',
    wgId: canonicalWgId,
    artifact: persisted.receipt.artifactPath,
    artifactSha256: persisted.receipt.artifactSha256,
    evidenceKind: persisted.receipt.evidenceKind,
    actionId: persisted.receipt.actionId,
    transition: persisted.transition,
    checkpointStage: persisted.checkpointStage,
    loop,
  };
}
