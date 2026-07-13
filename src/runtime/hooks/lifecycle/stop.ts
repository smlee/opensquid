import { buildRegistry, loadActivePacksForDispatch } from '../../bootstrap.js';
import type { FunctionRegistry } from '../../../functions/registry.js';
import type { Pack } from '../../types.js';
import { dispatchEvent } from '../dispatch.js';
import { claimUmbrellaLeaseForSession } from '../../chat/claim_lease.js';
import { maybeDriveInbound, maybePeekInbound } from '../stop_drive.js';
import { maybeIngestTurn } from '../stop_ingest.js';
import { maybeStreamOutput } from '../stop_stream.js';

import type { StopInput, LifecycleContext, StopOutput } from './types.js';

export interface StopHandlerDeps {
  maybeIngestTurn(raw?: string): Promise<unknown>;
  loadDispatch(sessionId: string): Promise<{
    packs: Pack[];
    registry: FunctionRegistry;
  }>;
  dispatchEvent: typeof dispatchEvent;
  claimUmbrellaLeaseForSession(sessionId: string, cwd: string): Promise<unknown>;
  maybePeekInbound(sessionId: string, cwd: string): Promise<string | null>;
  maybeStreamOutput(sessionId: string, cwd: string, assistantText: string): Promise<unknown>;
  maybeDriveInbound(sessionId: string, cwd: string): Promise<string | null>;
}

const DEFAULT_DEPS: StopHandlerDeps = {
  maybeIngestTurn,
  loadDispatch: async (sessionId) => ({
    packs: await loadActivePacksForDispatch(sessionId),
    registry: await buildRegistry(),
  }),
  dispatchEvent,
  claimUmbrellaLeaseForSession,
  maybePeekInbound,
  maybeStreamOutput,
  maybeDriveInbound,
};

export async function runStop(
  input: StopInput,
  ctx: LifecycleContext,
  deps: StopHandlerDeps = DEFAULT_DEPS,
): Promise<StopOutput> {
  if (ctx.role !== 'lap-child') await deps.maybeIngestTurn(input.raw);
  const { packs, registry } = await deps.loadDispatch(ctx.sessionId);
  const dispatched = await deps.dispatchEvent(input.event, packs, registry, ctx.sessionId);

  if (dispatched.exitCode !== 0) {
    const peek =
      ctx.role === 'lap-child' ? null : await deps.maybePeekInbound(ctx.sessionId, ctx.cwd);
    return {
      exitCode: dispatched.exitCode,
      stderr: peek === null ? dispatched.stderr : `${dispatched.stderr}\n\n${peek}`,
      contextInjections: [],
      directives: dispatched.directives,
      diagnostics: [],
    };
  }

  if (ctx.role === 'lap-child') {
    return {
      exitCode: 0,
      stderr: dispatched.stderr,
      contextInjections: dispatched.contextInjections,
      directives: dispatched.directives,
      diagnostics: [],
    };
  }

  if (!input.isLoopLap) {
    await deps.claimUmbrellaLeaseForSession(ctx.sessionId, ctx.cwd);
    await deps.maybeStreamOutput(ctx.sessionId, ctx.cwd, input.event.assistantText);
    const driveReason = await deps.maybeDriveInbound(ctx.sessionId, ctx.cwd);
    if (driveReason !== null) {
      return {
        exitCode: 0,
        stderr: dispatched.stderr,
        contextInjections: [],
        directives: dispatched.directives,
        diagnostics: [],
        continuationReason: driveReason,
      };
    }
  }

  return {
    exitCode: 0,
    stderr: dispatched.stderr,
    contextInjections: [],
    directives: dispatched.directives,
    diagnostics: [],
  };
}
