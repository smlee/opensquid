import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { resolveActorId } from '../actor_id.js';
import { resolveLocalStoreDir } from '../paths.js';
import { ensureLoopRunning, loopStatus } from '../ralph/loop_autospawn.js';
import { workGraphStore } from '../../workgraph/store.js';
import {
  listExecutorProcesses,
  markExecutorProcess,
  type HumanControlSurface,
} from './process_control.js';

export interface ResumeExecutorResult {
  readonly actionId: string;
  readonly executorId: string;
  readonly processInstanceId: string;
  readonly wgId: string;
  readonly requestedBy: HumanControlSurface;
  readonly authorizedBy: string;
  readonly requestedAtMs: number;
  readonly appliedAtMs: number;
  readonly loopStatus: 'spawned' | 'already_running' | 'waited_for_peer';
}

export interface ResumeExecutorDeps {
  list: typeof listExecutorProcesses;
  releaseClaim(wgId: string, cwd: string): Promise<void>;
  ensureLoop(cwd: string): ReturnType<typeof ensureLoopRunning>;
  mark: typeof markExecutorProcess;
}

async function ensureLoopAfterPause(cwd: string): ReturnType<typeof ensureLoopRunning> {
  const root = await resolveLocalStoreDir(cwd);
  const before = await loopStatus(root);
  if (before.running) {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const current = await loopStatus(root);
      if (!current.running || current.pid !== before.pid) break;
    }
  }
  return ensureLoopRunning(cwd);
}

const DEFAULT_DEPS: ResumeExecutorDeps = {
  list: listExecutorProcesses,
  releaseClaim: async (wgId, cwd) => {
    const dir = await resolveLocalStoreDir(cwd);
    const store = workGraphStore({
      dbUrl: `file:${join(dir, 'workgraph.db')}`,
      sourceDir: join(dir, 'store', 'issues'),
      actorId: await resolveActorId(),
    });
    await store.init();
    const issue = await store.getIssue(wgId);
    if (issue?.status !== 'open') {
      throw new Error(`cannot resume ${wgId}: WorkGraph item is not open`);
    }
    await store.releaseClaim(wgId);
  },
  ensureLoop: ensureLoopAfterPause,
  mark: markExecutorProcess,
};

/** Resume paused logical work from WorkGraph/checkpoint truth; never attempts to revive an old OS process. */
export async function resumeExecutorProcess(
  input: {
    executorId: string;
    requestedBy: HumanControlSurface;
    authorizedBy: string;
    cwd?: string;
  },
  deps: ResumeExecutorDeps = DEFAULT_DEPS,
): Promise<ResumeExecutorResult> {
  const state = (await deps.list()).find((candidate) => candidate.executorId === input.executorId);
  if (state?.status !== 'paused') {
    throw new Error(
      `executor ${input.executorId} cannot resume from status ${state?.status ?? 'missing'}`,
    );
  }
  const authorizedBy = input.authorizedBy.trim();
  if (authorizedBy === '')
    throw new Error('process-control authorization identity must be non-empty');
  const actionId = randomUUID();
  const requestedAtMs = Date.now();
  const cwd = input.cwd ?? process.cwd();
  await deps.releaseClaim(state.wgId, cwd);
  const loop = await deps.ensureLoop(cwd);
  if (loop.status === 'error') {
    throw new Error(`could not resume loop: ${loop.error}`);
  }
  const appliedAtMs = Date.now();
  await deps.mark(
    input.executorId,
    'resumed',
    undefined,
    input.requestedBy,
    state.wgId,
    state.processInstanceId,
    {
      actionId,
      action: 'resume',
      requestedBy: input.requestedBy,
      authorizedBy,
      requestedAtMs,
      appliedAtMs,
    },
  );
  return {
    actionId,
    executorId: input.executorId,
    processInstanceId: state.processInstanceId,
    wgId: state.wgId,
    requestedBy: input.requestedBy,
    authorizedBy,
    requestedAtMs,
    appliedAtMs,
    loopStatus: loop.status,
  };
}
