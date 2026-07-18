import { createClient } from '@libsql/client';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

import { buildInjectContext } from '../../functions/inject_context.js';
import type { FunctionRegistry } from '../../functions/registry.js';
import { applyConcurrencyPragmas } from '../../storage/sqlite_concurrency.js';
import { resolveActorId } from '../../runtime/actor_id.js';
import { CheckpointStore, type TaskCheckpoint } from '../../runtime/durable/checkpoint_store.js';
import { fsmStateKey, type FsmStateFile } from '../../runtime/fsm_state.js';
import { evaluateLane, laneBlockMessage } from '../../runtime/loop/write_lane.js';
import { resolveLocalStoreDir, sessionStateFile } from '../../runtime/paths.js';
import {
  readActiveTaskStrict,
  readSessionCwd,
  recordSessionCwd,
  writeActiveTask,
  type ActiveTask,
  type ActiveTaskRead,
} from '../../runtime/session_state.js';
import { isMutatingCall } from '../../runtime/guard/orchestrator_guard.js';
import { ok } from '../../runtime/result.js';
import { workGraphStore } from '../../workgraph/store.js';
import type { Issue } from '../../workgraph/types.js';

const PACK_ID = 'fullstack-flow';
const PREFIX = '/scope';
const ITEM_ID = /^wg-[a-f0-9]{12}$/u;
export const FULLSTACK_SCOPE_USAGE = 'usage: /scope <request> | /scope --item <wg-id>';

export type FullstackScopeRequest =
  | { readonly kind: 'create'; readonly title: string }
  | { readonly kind: 'select'; readonly itemId: string };

export type FullstackScopeParse =
  | { readonly kind: 'ignored' }
  | { readonly kind: 'invalid'; readonly message: string }
  | { readonly kind: 'request'; readonly request: FullstackScopeRequest };

/** Parse only the command forms owned by fullstack-flow; harnesses do not reinterpret these bytes. */
export function parseFullstackScope(raw: string): FullstackScopeParse {
  if (!raw.startsWith(PREFIX)) return { kind: 'ignored' };
  const boundary = raw.at(PREFIX.length);
  if (boundary !== undefined && !/\s/u.test(boundary)) return { kind: 'ignored' };
  const payload = raw.slice(PREFIX.length).trim();
  if (payload === '') return { kind: 'invalid', message: FULLSTACK_SCOPE_USAGE };
  const tokens = payload.split(/\s+/u);
  if (tokens[0] !== '--item') {
    return { kind: 'request', request: { kind: 'create', title: payload } };
  }
  const itemId = tokens[1];
  return tokens.length === 2 && itemId !== undefined && ITEM_ID.test(itemId)
    ? { kind: 'request', request: { kind: 'select', itemId } }
    : { kind: 'invalid', message: FULLSTACK_SCOPE_USAGE };
}

export interface FullstackScopePolicy {
  readonly packId: string;
  readonly initial: string;
  readonly states: ReadonlySet<string>;
  readonly writes: (stage: string) => readonly string[];
}

export type FsmProjectionRead =
  | { readonly kind: 'present'; readonly state: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'indeterminate'; readonly reason: string };

export type KnownEntryObservation =
  | { readonly kind: 'missing' }
  | { readonly kind: 'not_open' }
  | { readonly kind: 'item_only' }
  | { readonly kind: 'checkpoint_ready' }
  | { readonly kind: 'projection_pending' }
  | { readonly kind: 'active_conflict' }
  | { readonly kind: 'advanced'; readonly stage: string }
  | { readonly kind: 'engaged'; readonly stage: string; readonly writes: readonly string[] }
  | { readonly kind: 'indeterminate'; readonly reason: string };

/** Pure canonical-state classifier. TaskCheckpoint.stage remains the cross-session stage authority. */
export function classifyKnownEntry(
  issue: Issue | null,
  checkpoint: TaskCheckpoint | null,
  active: ActiveTaskRead,
  fsm: FsmProjectionRead,
  policy: FullstackScopePolicy,
): KnownEntryObservation {
  if (issue === null) return { kind: 'missing' };
  if (issue.status !== 'open') return { kind: 'not_open' };
  if (checkpoint === null) return { kind: 'item_only' };
  if (checkpoint.stage !== policy.initial) {
    return policy.states.has(checkpoint.stage)
      ? { kind: 'advanced', stage: checkpoint.stage }
      : { kind: 'indeterminate', reason: `unknown checkpoint stage: ${checkpoint.stage}` };
  }
  if (active.kind === 'indeterminate') return { kind: 'indeterminate', reason: active.reason };
  if (active.kind === 'absent') return { kind: 'checkpoint_ready' };
  if (
    active.task.id !== issue.id ||
    (active.task.taskId !== undefined && active.task.taskId !== active.task.id)
  ) {
    return { kind: 'active_conflict' };
  }
  if (fsm.kind === 'indeterminate') return fsm;
  if (fsm.kind === 'absent') return { kind: 'projection_pending' };
  if (fsm.state !== checkpoint.stage) {
    return {
      kind: 'indeterminate',
      reason: `checkpoint/FSM divergence: ${checkpoint.stage}/${fsm.state}`,
    };
  }
  return { kind: 'engaged', stage: checkpoint.stage, writes: policy.writes(checkpoint.stage) };
}

export type FullstackScopeResult =
  | { readonly kind: 'ignored' }
  | { readonly kind: 'rejected'; readonly message: string }
  | {
      readonly kind: 'failed';
      readonly message: string;
      readonly durableState:
        | 'creation_indeterminate'
        | 'item_only'
        | 'checkpoint_ready'
        | 'active_conflict'
        | 'advanced'
        | 'indeterminate';
      readonly itemId?: string;
      readonly recovery?: string;
    }
  | {
      readonly kind: 'engaged';
      readonly itemId: string;
      readonly context: string;
      readonly continuationPrompt: string;
    };

export type ScopeEntryAttemptKind =
  | 'start'
  | 'parsed'
  | 'selected'
  | 'checkpointed'
  | 'published'
  | 'projected'
  | 'context_ready';

export type ScopeEntryAttempt =
  | { readonly kind: ScopeEntryAttemptKind }
  | { readonly kind: 'done'; readonly result: FullstackScopeResult };

export type ScopeEntryAttemptEvent =
  | { readonly kind: 'parsed' }
  | { readonly kind: 'selected' }
  | { readonly kind: 'checkpointed' }
  | { readonly kind: 'published' }
  | { readonly kind: 'projected' }
  | { readonly kind: 'context_ready' }
  | { readonly kind: 'finish'; readonly result: FullstackScopeResult };

const ATTEMPT_NEXT: Readonly<
  Record<
    ScopeEntryAttemptKind,
    Partial<Record<ScopeEntryAttemptEvent['kind'], ScopeEntryAttemptKind>>
  >
> = {
  start: { parsed: 'parsed' },
  parsed: { selected: 'selected' },
  selected: { checkpointed: 'checkpointed' },
  checkpointed: { published: 'published' },
  published: { projected: 'projected' },
  projected: { context_ready: 'context_ready' },
  context_ready: {},
};

/** Pure, total, ephemeral ordering check; this is deliberately not another persisted workflow. */
export function stepScopeEntryAttempt(
  state: ScopeEntryAttempt,
  event: ScopeEntryAttemptEvent,
): ScopeEntryAttempt {
  if (state.kind === 'done') return state;
  if (event.kind === 'finish') {
    if (event.result.kind !== 'engaged' || state.kind === 'context_ready') {
      return { kind: 'done', result: event.result };
    }
  } else {
    const next = ATTEMPT_NEXT[state.kind][event.kind];
    if (next !== undefined) return { kind: next };
  }
  return {
    kind: 'done',
    result: {
      kind: 'failed',
      message: 'illegal scope-entry transition',
      durableState: 'indeterminate',
    },
  };
}

export interface ScopeWorkGraph {
  createIssue(input: { title: string; body?: string }): Promise<Issue>;
  getIssue(id: string): Promise<Issue | null>;
}

export interface FullstackScopeDeps {
  resolvePolicy(sessionId: string, cwd: string): Promise<FullstackScopePolicy | null>;
  openWorkGraph(cwd: string): Promise<ScopeWorkGraph>;
  readCheckpoint(cwd: string, itemId: string): Promise<TaskCheckpoint | null>;
  createCheckpoint(cwd: string, itemId: string, stage: string, nowMs: number): Promise<void>;
  readActiveTask(sessionId: string): Promise<ActiveTaskRead>;
  writeActiveTask(sessionId: string, task: ActiveTask): Promise<void>;
  recordSessionCwd(sessionId: string, cwd: string): Promise<void>;
  initializeV2Cartridges(sessionId: string, now: string, cwd: string): Promise<void>;
  readProjection(sessionId: string, packId: string, itemId: string): Promise<FsmStateFile | null>;
  buildContext(sessionId: string, packId: string, fsm: FsmStateFile): Promise<string>;
  now(): string;
}

export interface FullstackScopeCommand {
  readonly name: 'scope';
  readonly description: string;
  execute(input: { raw: string; sessionId: string; cwd: string }): Promise<FullstackScopeResult>;
}

function recoveryFor(itemId: string): string {
  return `/scope --item ${itemId}`;
}

function failedFromObservation(
  itemId: string,
  observation: KnownEntryObservation,
  message: string,
): FullstackScopeResult {
  switch (observation.kind) {
    case 'advanced':
      return {
        kind: 'failed',
        message: `${message}; item is already at ${observation.stage} and cannot be rewound by /scope`,
        durableState: 'advanced',
        itemId,
      };
    case 'active_conflict':
      return { kind: 'failed', message, durableState: 'active_conflict', itemId };
    case 'item_only':
      return {
        kind: 'failed',
        message,
        durableState: 'item_only',
        itemId,
        recovery: recoveryFor(itemId),
      };
    case 'checkpoint_ready':
    case 'projection_pending':
    case 'engaged':
      return {
        kind: 'failed',
        message,
        durableState: 'checkpoint_ready',
        itemId,
        recovery: recoveryFor(itemId),
      };
    default:
      return { kind: 'failed', message, durableState: 'indeterminate', itemId };
  }
}

async function readObservation(
  deps: FullstackScopeDeps,
  graph: ScopeWorkGraph,
  policy: FullstackScopePolicy,
  sessionId: string,
  cwd: string,
  itemId: string,
): Promise<KnownEntryObservation> {
  let selected: Issue | null;
  let checkpoint: TaskCheckpoint | null;
  let active: ActiveTaskRead;
  let projection: FsmProjectionRead;
  try {
    selected = await graph.getIssue(itemId);
  } catch (error) {
    return { kind: 'indeterminate', reason: `WorkGraph read failed: ${String(error)}` };
  }
  try {
    checkpoint = await deps.readCheckpoint(cwd, itemId);
  } catch (error) {
    return { kind: 'indeterminate', reason: `checkpoint read failed: ${String(error)}` };
  }
  try {
    active = await deps.readActiveTask(sessionId);
  } catch (error) {
    active = { kind: 'indeterminate', reason: `active-task read failed: ${String(error)}` };
  }
  try {
    const fsm = await deps.readProjection(sessionId, policy.packId, itemId);
    projection = fsm === null ? { kind: 'absent' } : { kind: 'present', state: fsm.state };
  } catch (error) {
    projection = { kind: 'indeterminate', reason: `FSM projection read failed: ${String(error)}` };
  }
  return classifyKnownEntry(selected, checkpoint, active, projection, policy);
}

function rejectionForKnown(
  itemId: string,
  observation: KnownEntryObservation,
): FullstackScopeResult {
  switch (observation.kind) {
    case 'missing':
      return {
        kind: 'rejected',
        message: `scope entry rejected: local WorkGraph item ${itemId} was not found`,
      };
    case 'not_open':
      return {
        kind: 'rejected',
        message: `scope entry rejected: WorkGraph item ${itemId} is not open`,
      };
    case 'advanced':
      return failedFromObservation(
        itemId,
        observation,
        `scope entry rejected: WorkGraph item ${itemId} is already at ${observation.stage}`,
      );
    case 'active_conflict':
      return failedFromObservation(
        itemId,
        observation,
        `scope entry rejected: another active task conflicts with ${itemId}`,
      );
    default:
      return failedFromObservation(
        itemId,
        observation,
        `scope entry for ${itemId} is indeterminate`,
      );
  }
}

const ATTEMPT_ORDER: readonly ScopeEntryAttemptEvent[] = [
  { kind: 'parsed' },
  { kind: 'selected' },
  { kind: 'checkpointed' },
  { kind: 'published' },
  { kind: 'projected' },
  { kind: 'context_ready' },
];

function advanceAttemptTo(
  state: ScopeEntryAttempt,
  target: ScopeEntryAttemptKind,
): ScopeEntryAttempt {
  while (state.kind !== 'done' && state.kind !== target) {
    const index = ATTEMPT_ORDER.findIndex((event) => event.kind === state.kind);
    const event = ATTEMPT_ORDER[index + 1];
    if (event === undefined) break;
    state = stepScopeEntryAttempt(state, event);
  }
  return state;
}

async function executeKnown(
  deps: FullstackScopeDeps,
  graph: ScopeWorkGraph,
  policy: FullstackScopePolicy,
  itemId: string,
  sessionId: string,
  cwd: string,
  initialAttempt: ScopeEntryAttempt,
): Promise<FullstackScopeResult> {
  let attempt = initialAttempt;
  for (let step = 0; step < 8; step += 1) {
    const observation = await readObservation(deps, graph, policy, sessionId, cwd, itemId);
    if (
      observation.kind === 'missing' ||
      observation.kind === 'not_open' ||
      observation.kind === 'advanced' ||
      observation.kind === 'active_conflict'
    ) {
      return rejectionForKnown(itemId, observation);
    }
    if (observation.kind === 'indeterminate') {
      return failedFromObservation(itemId, observation, observation.reason);
    }
    if (observation.kind === 'item_only') {
      attempt = advanceAttemptTo(attempt, 'selected');
      try {
        await deps.createCheckpoint(cwd, itemId, policy.initial, Date.parse(deps.now()));
      } catch (error) {
        const after = await readObservation(deps, graph, policy, sessionId, cwd, itemId);
        if (after.kind !== observation.kind) continue;
        return failedFromObservation(
          itemId,
          after,
          `scope checkpoint write failed: ${String(error)}`,
        );
      }
      continue;
    }
    if (observation.kind === 'checkpoint_ready') {
      attempt = advanceAttemptTo(attempt, 'checkpointed');
      try {
        await deps.writeActiveTask(sessionId, {
          id: itemId,
          subject: itemId,
          started_at: deps.now(),
        });
      } catch (error) {
        const after = await readObservation(deps, graph, policy, sessionId, cwd, itemId);
        if (after.kind !== observation.kind) continue;
        return failedFromObservation(itemId, after, `active-task write failed: ${String(error)}`);
      }
      continue;
    }
    if (observation.kind === 'projection_pending') {
      attempt = advanceAttemptTo(attempt, 'published');
      try {
        await deps.recordSessionCwd(sessionId, cwd);
        await deps.initializeV2Cartridges(sessionId, deps.now(), cwd);
      } catch (error) {
        const after = await readObservation(deps, graph, policy, sessionId, cwd, itemId);
        if (after.kind !== observation.kind) continue;
        return failedFromObservation(itemId, after, `scope projection failed: ${String(error)}`);
      }
      continue;
    }

    attempt = advanceAttemptTo(attempt, 'projected');
    try {
      const fsm = await deps.readProjection(sessionId, policy.packId, itemId);
      if (fsm === null) {
        return failedFromObservation(
          itemId,
          observation,
          'scope projection disappeared before context build',
        );
      }
      const context = await deps.buildContext(sessionId, policy.packId, fsm);
      const final = await readObservation(deps, graph, policy, sessionId, cwd, itemId);
      if (
        final.kind !== 'engaged' ||
        final.stage !== observation.stage ||
        final.writes.join('\0') !== observation.writes.join('\0')
      ) {
        return failedFromObservation(
          itemId,
          final,
          'scope state changed while context was being built',
        );
      }
      const selected = await graph.getIssue(itemId);
      if (selected?.status !== 'open') {
        return {
          kind: 'rejected',
          message: `scope entry rejected: WorkGraph item ${itemId} is no longer open`,
        };
      }
      const engaged: FullstackScopeResult = {
        kind: 'engaged',
        itemId,
        context,
        continuationPrompt: `Begin interactive SCOPE for WorkGraph item ${itemId}: ${selected.title}`,
      };
      attempt = advanceAttemptTo(attempt, 'context_ready');
      const finished = stepScopeEntryAttempt(attempt, { kind: 'finish', result: engaged });
      return finished.kind === 'done' ? finished.result : engaged;
    } catch (error) {
      return failedFromObservation(
        itemId,
        observation,
        `scope context build failed: ${String(error)}`,
      );
    }
  }
  return {
    kind: 'failed',
    message: `scope entry for ${itemId} did not converge after bounded reconciliation`,
    durableState: 'indeterminate',
    itemId,
  };
}

/** Build the one descriptor/operation. The queue linearizes attempts without persisting another lifecycle. */
export function createFullstackScopeCommand(deps: FullstackScopeDeps): FullstackScopeCommand {
  const queues = new Map<string, Promise<void>>();
  const serialized = async <T>(key: string, run: () => Promise<T>): Promise<T> => {
    const prior = queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = prior.then(() => current);
    queues.set(key, queued);
    await prior;
    try {
      return await run();
    } finally {
      release();
      if (queues.get(key) === queued) queues.delete(key);
    }
  };

  return {
    name: 'scope',
    description: 'Create or select a project-local WorkGraph item and enter fullstack-flow SCOPE',
    execute: ({ raw, sessionId, cwd }) =>
      serialized(`${cwd}\0${sessionId}`, async () => {
        const parsed = parseFullstackScope(raw);
        if (parsed.kind === 'ignored') return parsed;
        if (parsed.kind === 'invalid') return { kind: 'rejected', message: parsed.message };
        let attempt = stepScopeEntryAttempt({ kind: 'start' }, { kind: 'parsed' });

        let policy: FullstackScopePolicy | null;
        try {
          policy = await deps.resolvePolicy(sessionId, cwd);
        } catch (error) {
          return {
            kind: 'failed',
            message: `scope policy read failed: ${String(error)}`,
            durableState: 'indeterminate',
          };
        }
        if (policy === null) {
          return {
            kind: 'rejected',
            message: 'scope entry rejected: fullstack-flow is not active for this project',
          };
        }

        let graph: ScopeWorkGraph;
        try {
          graph = await deps.openWorkGraph(cwd);
        } catch (error) {
          return {
            kind: 'failed',
            message: `project-local WorkGraph open failed: ${String(error)}`,
            durableState: 'indeterminate',
          };
        }

        let itemId: string;
        if (parsed.request.kind === 'create') {
          try {
            itemId = (await graph.createIssue({ title: parsed.request.title })).id;
          } catch (error) {
            return {
              kind: 'failed',
              message: `WorkGraph creation result is indeterminate: ${String(error)}`,
              durableState: 'creation_indeterminate',
            };
          }
        } else {
          itemId = parsed.request.itemId;
        }
        attempt = stepScopeEntryAttempt(attempt, { kind: 'selected' });
        return executeKnown(deps, graph, policy, itemId, sessionId, cwd, attempt);
      }),
  };
}

async function withProjectCheckpoint<T>(
  cwd: string,
  run: (store: CheckpointStore) => Promise<T>,
): Promise<T> {
  const dir = await resolveLocalStoreDir(cwd);
  const client = createClient({ url: `file:${join(dir, 'opensquid.db')}` });
  await applyConcurrencyPragmas(client);
  try {
    return await run(new CheckpointStore(client));
  } finally {
    client.close();
  }
}

function isFsmStateFile(value: unknown): value is FsmStateFile {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.state === 'string' &&
    typeof record.started_at === 'string' &&
    Array.isArray(record.history)
  );
}

async function readProjectionStrict(
  sessionId: string,
  packId: string,
  itemId: string,
): Promise<FsmStateFile | null> {
  try {
    const parsed = JSON.parse(
      await readFile(sessionStateFile(sessionId, fsmStateKey(packId, itemId)), 'utf8'),
    ) as unknown;
    if (!isFsmStateFile(parsed)) throw new Error('malformed FSM projection');
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function resolveProductionPolicy(
  sessionId: string,
  cwd: string,
): Promise<FullstackScopePolicy | null> {
  const { loadActiveV2Cartridges } = await import('../../runtime/bootstrap.js');
  const loaded = (await loadActiveV2Cartridges(sessionId, cwd)).find(
    (candidate) => candidate.pack.name === PACK_ID,
  );
  if (loaded?.compiled.fsm === undefined) return null;
  return {
    packId: loaded.pack.name,
    initial: loaded.compiled.fsm.initial,
    states: new Set(loaded.compiled.fsm.states),
    writes: (stage) => loaded.compiled.meta[stage]?.writes ?? [],
  };
}

const PRODUCTION_DEPS: FullstackScopeDeps = {
  resolvePolicy: resolveProductionPolicy,
  openWorkGraph: async (cwd) => {
    const dir = await resolveLocalStoreDir(cwd);
    const store = workGraphStore({
      dbUrl: `file:${join(dir, 'workgraph.db')}`,
      sourceDir: join(dir, 'store', 'issues'),
      actorId: await resolveActorId(),
    });
    await store.init();
    return store;
  },
  readCheckpoint: (cwd, itemId) =>
    withProjectCheckpoint(cwd, (store) => store.getTaskCheckpoint(itemId)),
  createCheckpoint: (cwd, itemId, stage, nowMs) =>
    withProjectCheckpoint(cwd, (store) => store.createTaskCheckpoint(itemId, stage, nowMs)),
  readActiveTask: readActiveTaskStrict,
  writeActiveTask,
  recordSessionCwd,
  initializeV2Cartridges: async (sessionId, now, cwd) => {
    const { initializeV2Cartridges } = await import('../../runtime/loop/v2_supply.js');
    await initializeV2Cartridges(sessionId, now, cwd);
  },
  readProjection: readProjectionStrict,
  buildContext: async (sessionId, packId, fsm) => {
    const { buildStageBundle } = await import('../../functions/stage_context.js');
    return buildStageBundle(sessionId, packId, fsm);
  },
  now: () => new Date().toISOString(),
};

export const fullstackScopeCommand = createFullstackScopeCommand(PRODUCTION_DEPS);

export type ScopeEngagement =
  | {
      readonly kind: 'engaged';
      readonly itemId: string;
      readonly stage: string;
      readonly writes: readonly string[];
    }
  | { readonly kind: 'unengaged' }
  | { readonly kind: 'indeterminate'; readonly itemId?: string; readonly reason: string };

/** Resolve engagement from existing active-task, WorkGraph, checkpoint, policy, and FSM projection records. */
export async function resolveFullstackScopeEngagement(
  input: { sessionId: string; cwd: string },
  deps: FullstackScopeDeps = PRODUCTION_DEPS,
): Promise<ScopeEngagement> {
  const active = await deps.readActiveTask(input.sessionId).catch((error: unknown) => ({
    kind: 'indeterminate' as const,
    reason: `active-task read failed: ${String(error)}`,
  }));
  if (active.kind === 'absent') return { kind: 'unengaged' };
  if (active.kind === 'indeterminate') return active;
  const itemId = active.task.id;
  if (!ITEM_ID.test(itemId)) return { kind: 'unengaged' };
  if (active.task.taskId !== undefined && active.task.taskId !== itemId) {
    return { kind: 'indeterminate', itemId, reason: 'active-task id/taskId conflict' };
  }

  let policy: FullstackScopePolicy | null;
  try {
    policy = await deps.resolvePolicy(input.sessionId, input.cwd);
  } catch (error) {
    return { kind: 'indeterminate', itemId, reason: `scope policy read failed: ${String(error)}` };
  }
  if (policy === null) return { kind: 'unengaged' };
  let graph: ScopeWorkGraph;
  try {
    graph = await deps.openWorkGraph(input.cwd);
  } catch (error) {
    return { kind: 'indeterminate', itemId, reason: `WorkGraph open failed: ${String(error)}` };
  }

  let selected: Issue | null;
  try {
    selected = await graph.getIssue(itemId);
  } catch (error) {
    return { kind: 'indeterminate', itemId, reason: `WorkGraph read failed: ${String(error)}` };
  }
  if (selected?.status !== 'open') return { kind: 'unengaged' };
  if (selected.id !== itemId) {
    return {
      kind: 'indeterminate',
      itemId,
      reason: 'WorkGraph identity conflicts with active task',
    };
  }

  let checkpoint: TaskCheckpoint | null;
  try {
    checkpoint = await deps.readCheckpoint(input.cwd, itemId);
  } catch (error) {
    return { kind: 'indeterminate', itemId, reason: `checkpoint read failed: ${String(error)}` };
  }
  if (checkpoint === null || !policy.states.has(checkpoint.stage)) return { kind: 'unengaged' };

  let projection: FsmStateFile | null;
  try {
    projection = await deps.readProjection(input.sessionId, policy.packId, itemId);
  } catch (error) {
    return {
      kind: 'indeterminate',
      itemId,
      reason: `FSM projection read failed: ${String(error)}`,
    };
  }
  if (projection === null) {
    return { kind: 'indeterminate', itemId, reason: 'engaged checkpoint has no FSM projection' };
  }
  if (projection.state !== checkpoint.stage) {
    return {
      kind: 'indeterminate',
      itemId,
      reason: `checkpoint/FSM divergence: ${checkpoint.stage}/${projection.state}`,
    };
  }
  return {
    kind: 'engaged',
    itemId,
    stage: checkpoint.stage,
    writes: policy.writes(checkpoint.stage),
  };
}

export type EngagedWriteDecision =
  | { readonly kind: 'not_applicable' }
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly message: string };

/** Pure adapter over the existing mutation classifier and pack-declared lane evaluator. */
export function decideFullstackScopeWrite(
  engagement: ScopeEngagement,
  tool: string,
  args: Record<string, unknown>,
): EngagedWriteDecision {
  if (engagement.kind === 'unengaged') return { kind: 'not_applicable' };
  if (engagement.kind === 'indeterminate') {
    return isMutatingCall(tool, args)
      ? {
          kind: 'deny',
          message: `scope engagement is indeterminate${engagement.itemId === undefined ? '' : ` for ${engagement.itemId}`}: ${engagement.reason}`,
        }
      : { kind: 'allow' };
  }
  const lane = evaluateLane(engagement.writes, tool, args);
  if (lane.checked && lane.outOfLane && lane.path !== null) {
    return {
      kind: 'deny',
      message: laneBlockMessage(engagement.stage, lane.path, engagement.writes),
    };
  }
  return { kind: 'allow' };
}

type ScopeFailureResult = Extract<FullstackScopeResult, { kind: 'rejected' | 'failed' }>;

export function renderScopeFailure(result: ScopeFailureResult): string {
  if (result.kind === 'rejected') return result.message;
  return [
    result.message,
    result.itemId === undefined ? '' : `WorkGraph item: ${result.itemId}`,
    result.recovery === undefined ? '' : `Recovery: ${result.recovery}`,
  ]
    .filter((line) => line.length > 0)
    .join('\n');
}

export interface FullstackScopeEntryDeps {
  readonly command: FullstackScopeCommand;
  readonly readCwd: (sessionId: string) => Promise<string | null>;
}

const ScopeEntryArgs = z.object({ raw: z.string() }).strict();
type ScopeEntryPrimitiveResult =
  | ReturnType<typeof buildInjectContext>
  | { readonly level: 'block'; readonly message: string }
  | null;

/** Registry projection used by the pack-owned prompt_submit skill for Claude and Codex. */
export function registerFullstackScopeEntry(
  registry: FunctionRegistry,
  deps: FullstackScopeEntryDeps = { command: fullstackScopeCommand, readCwd: readSessionCwd },
): void {
  registry.register<z.infer<typeof ScopeEntryArgs>, ScopeEntryPrimitiveResult>({
    name: 'fullstack_scope_entry',
    argSchema: ScopeEntryArgs,
    durable: false,
    memoizable: false,
    costEstimateMs: 5,
    execute: async ({ raw }, ctx) => {
      // The pack skill forwards every prompt. Preserve ignored prompts as a true no-op even when session-start
      // state is unavailable; cwd is authority only after the sole pack-owned parser recognizes `/scope`.
      if (parseFullstackScope(raw).kind === 'ignored') return ok(null);
      const cwd = await deps.readCwd(ctx.sessionId);
      if (cwd === null) {
        return ok({
          level: 'block' as const,
          message: 'scope entry blocked: session start did not record a project cwd',
        });
      }
      const result = await deps.command.execute({ raw, sessionId: ctx.sessionId, cwd });
      if (result.kind === 'ignored') return ok(null);
      if (result.kind === 'engaged') return ok(buildInjectContext(result.context));
      return ok({ level: 'block' as const, message: renderScopeFailure(result) });
    },
  });
}
