import { buildRegistry, loadActivePacksForDispatch } from '../../bootstrap.js';
import type { FunctionRegistry } from '../../../functions/registry.js';
import type { Pack } from '../../types.js';
import { dispatchEvent } from '../dispatch.js';
import { runV2Cartridges } from '../../loop/v2_supply.js';
import { floorMessage, observeCall } from '../../guard/floor_hook.js';

import type { PostToolCallInput, LifecycleContext, LifecycleOutput } from './types.js';

export interface PostToolCallHandlerDeps {
  loadDispatch(
    sessionId: string,
    registry?: FunctionRegistry,
  ): Promise<{
    packs: Pack[];
    registry: FunctionRegistry;
  }>;
  dispatchEvent: typeof dispatchEvent;
  runV2Cartridges: typeof runV2Cartridges;
  observeCall: typeof observeCall;
}

const DEFAULT_DEPS: PostToolCallHandlerDeps = {
  loadDispatch: async (sessionId, registry) => ({
    packs: await loadActivePacksForDispatch(sessionId),
    registry: registry ?? (await buildRegistry()),
  }),
  dispatchEvent,
  runV2Cartridges,
  observeCall,
};

export async function runPostToolCall(
  input: PostToolCallInput,
  ctx: LifecycleContext,
  deps: PostToolCallHandlerDeps = DEFAULT_DEPS,
): Promise<LifecycleOutput> {
  const event = input.event;
  const diagnostics: string[] = [];
  const { packs, registry } = await deps.loadDispatch(ctx.sessionId, ctx.registry);
  const dispatched = await deps.dispatchEvent(event, packs, registry, ctx.sessionId);
  const v2 = await deps.runV2Cartridges(ctx.sessionId, event, ctx.now);
  const stderrParts = [dispatched.stderr, ...v2.messages, ...v2.injections].filter(Boolean);
  try {
    const action = await deps.observeCall(ctx.sessionId, {
      tool: event.tool,
      args: event.args,
      exitCode: event.exit_code,
    });
    if (action !== 'pass') stderrParts.push(floorMessage(action, event.tool));
  } catch {
    // fail-open
  }
  return {
    // Post-tool observations can direct the next action but cannot undo an already executed call.
    exitCode: dispatched.exitCode === 2 ? 0 : dispatched.exitCode,
    stderr: stderrParts.join('\n'),
    contextInjections: [],
    directives: dispatched.directives,
    diagnostics,
  };
}
