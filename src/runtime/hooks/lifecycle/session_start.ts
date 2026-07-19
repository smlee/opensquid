import { buildRegistry, loadActivePacksForDispatch } from '../../bootstrap.js';
import type { FunctionRegistry } from '../../../functions/registry.js';
import type { Pack } from '../../types.js';
import { claimUmbrellaLeaseForSession } from '../../chat/claim_lease.js';
import { dispatchEvent } from '../dispatch.js';
import { recordCurrentSession } from '../session_id.js';
import { initializeV2Cartridges } from '../../loop/v2_supply.js';
import { recordSessionCwd, writeActiveTask } from '../../session_state.js';

import type { SessionStartInput, LifecycleContext, LifecycleOutput } from './types.js';

export interface SessionStartHandlerDeps {
  recordCurrentSession(sessionId: string, cwd: string): Promise<unknown>;
  recordSessionCwd(sessionId: string, cwd: string): Promise<void>;
  claimUmbrellaLeaseForSession(
    sessionId: string,
    cwd: string,
    options: { forceTakeover: boolean },
  ): Promise<unknown>;
  ensureLapActiveTask(sessionId: string, itemId: string, now: string): Promise<void>;
  initializeV2(sessionId: string, now: string): Promise<void>;
  loadDispatch(
    sessionId: string,
    registry?: FunctionRegistry,
  ): Promise<{
    packs: Pack[];
    registry: FunctionRegistry;
  }>;
  dispatchEvent: typeof dispatchEvent;
}

const DEFAULT_DEPS: SessionStartHandlerDeps = {
  recordCurrentSession,
  recordSessionCwd,
  claimUmbrellaLeaseForSession,
  ensureLapActiveTask: async (sessionId, itemId, now) => {
    await writeActiveTask(sessionId, {
      id: itemId,
      taskId: itemId,
      subject: itemId,
      started_at: now,
    });
  },
  initializeV2: initializeV2Cartridges,
  loadDispatch: async (sessionId, registry) => ({
    packs: await loadActivePacksForDispatch(sessionId),
    registry: registry ?? (await buildRegistry()),
  }),
  dispatchEvent,
};

const EMPTY: LifecycleOutput = {
  exitCode: 0,
  stderr: '',
  contextInjections: [],
  directives: [],
  diagnostics: [],
};

export async function runSessionStart(
  input: SessionStartInput,
  ctx: LifecycleContext,
  deps: SessionStartHandlerDeps = DEFAULT_DEPS,
): Promise<LifecycleOutput> {
  const event = input.event;
  if (event.source === 'clear' || event.source === 'compact' || ctx.role === 'reviewer')
    return EMPTY;
  const diagnostics: string[] = [];
  const startCwd = event.cwd ?? ctx.cwd;
  // Stage injection can run on the first prompt before any tool call. Persist cwd at session start for every role
  // so strict docsRoot resolution never guesses or falls back during that first injection.
  await deps.recordSessionCwd(ctx.sessionId, startCwd);
  await deps.recordCurrentSession(ctx.sessionId, startCwd);
  await deps.claimUmbrellaLeaseForSession(ctx.sessionId, startCwd, { forceTakeover: true });
  if (ctx.role === 'stage_process' && ctx.itemId !== undefined) {
    try {
      await deps.ensureLapActiveTask(ctx.sessionId, ctx.itemId, ctx.now);
    } catch (error) {
      diagnostics.push(`opensquid: lap active-task initialization failed — ${String(error)}`);
    }
  }
  try {
    await deps.initializeV2(ctx.sessionId, ctx.now);
  } catch (error) {
    diagnostics.push(`opensquid: v2 session initialization failed — ${String(error)}`);
  }
  const { packs, registry } = await deps.loadDispatch(ctx.sessionId, ctx.registry);
  const result = await deps.dispatchEvent(event, packs, registry, ctx.sessionId);
  return {
    exitCode: result.exitCode,
    stderr: [result.stderr, ...diagnostics].filter(Boolean).join('\n'),
    contextInjections: result.contextInjections,
    directives: result.directives,
    diagnostics,
  };
}
