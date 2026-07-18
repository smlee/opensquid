import { buildRegistry, loadActivePacksForDispatch } from '../../bootstrap.js';
import type { FunctionRegistry } from '../../../functions/registry.js';
import type { LoadedPackV2 } from '../../../packs/loader_v2.js';
import type { Pack } from '../../types.js';
import { listInstalledV2Packs } from '../../../packs/installed.js';
import { orchestrate } from '../../loop/orchestrate.js';
import { claimUmbrellaLeaseForSession } from '../../chat/claim_lease.js';
import { drainUmbrellaInbox } from '../../chat/inbox_drain.js';
import { resetTurnLedger, writeClassifiedFacets, writeRequestType } from '../../session_state.js';
import { classify } from '../../classify.js';
import { readSettings } from '../../orchestrator_settings.js';
import { classifyRequestType } from '../../request_type.js';
import { sha256Hex } from '../../durable/run_id.js';
import { dispatchEvent } from '../dispatch.js';
import { detectNewProject } from '../new_project_detect.js';
import { recordCurrentSession } from '../session_id.js';
import { runV2Cartridges } from '../../loop/v2_supply.js';

import type { PromptSubmitInput, LifecycleContext, LifecycleOutput } from './types.js';

export interface PromptSubmitHandlerDeps {
  recordCurrentSession(sessionId: string, cwd: string): Promise<unknown>;
  claimUmbrellaLeaseForSession(sessionId: string, cwd: string): Promise<unknown>;
  resetTurnLedger(sessionId: string): Promise<unknown>;
  writeRequestType(sessionId: string, value: Record<string, unknown>): Promise<unknown>;
  detectNewProject(sessionId: string): Promise<string | null>;
  drainUmbrellaInbox(sessionId: string): Promise<string>;
  listInstalledV2Packs(cwd: string): Promise<readonly LoadedPackV2[]>;
  orchestrate: typeof orchestrate;
  readSettings(cwd: string): Promise<Record<string, unknown>>;
  writeClassifiedFacets(sessionId: string, facets: ReturnType<typeof classify>): Promise<unknown>;
  loadDispatch(
    sessionId: string,
    registry?: FunctionRegistry,
  ): Promise<{
    packs: Pack[];
    registry: FunctionRegistry;
  }>;
  dispatchEvent: typeof dispatchEvent;
  runV2Cartridges: typeof runV2Cartridges;
}

const DEFAULT_DEPS: PromptSubmitHandlerDeps = {
  recordCurrentSession,
  claimUmbrellaLeaseForSession,
  resetTurnLedger,
  writeRequestType: (sessionId, value) => writeRequestType(sessionId, value as never),
  detectNewProject,
  drainUmbrellaInbox,
  listInstalledV2Packs,
  orchestrate,
  readSettings,
  writeClassifiedFacets,
  loadDispatch: async (sessionId, registry) => ({
    packs: await loadActivePacksForDispatch(sessionId),
    registry: registry ?? (await buildRegistry()),
  }),
  dispatchEvent,
  runV2Cartridges,
};

export async function runPromptSubmit(
  input: PromptSubmitInput,
  ctx: LifecycleContext,
  deps: PromptSubmitHandlerDeps = DEFAULT_DEPS,
): Promise<LifecycleOutput> {
  const event = input.event;
  const diagnostics: string[] = [];
  if (ctx.role === 'reviewer') {
    return { exitCode: 0, stderr: '', contextInjections: [], directives: [], diagnostics };
  }
  await deps.recordCurrentSession(ctx.sessionId, ctx.cwd);
  await deps.claimUmbrellaLeaseForSession(ctx.sessionId, ctx.cwd);
  try {
    await deps.resetTurnLedger(ctx.sessionId);
  } catch (error) {
    diagnostics.push(`opensquid: tool-ledger turn-reset failed — ${String(error)}`);
  }
  try {
    const cls = classifyRequestType(event.prompt);
    await deps.writeRequestType(ctx.sessionId, {
      ...cls,
      source: 'deterministic',
      prompt_hash: sha256Hex(event.prompt).slice(0, 16),
      at: ctx.now,
    });
  } catch (error) {
    diagnostics.push(`opensquid: request-type classification failed — ${String(error)}`);
  }
  const { packs, registry } = await deps.loadDispatch(ctx.sessionId, ctx.registry);
  const dispatched = await deps.dispatchEvent(event, packs, registry, ctx.sessionId);
  // The v2 host is separate from the legacy/skill dispatcher. Prompt submission must reach both: v2 captures
  // the immutable ask anchor here and routes prompt-triggered state skills. Omitting this call leaves
  // `scope.anchors_ok` permanently false in Pi and also regresses the extracted existing-host handler.
  const v2 = await deps.runV2Cartridges(ctx.sessionId, event, ctx.now);
  const exitCode = dispatched.exitCode === 2 || v2.exitCode === 2 ? 2 : dispatched.exitCode;
  const stderr = [dispatched.stderr, ...v2.messages].filter(Boolean).join('\n');
  const dispatchInjections = [...dispatched.contextInjections, ...v2.injections];
  const newProjectLine = await deps.detectNewProject(ctx.sessionId);
  const inboxEnvelope = await deps.drainUmbrellaInbox(ctx.sessionId);

  let orchInjections: string[] = [];
  try {
    const v2packs = (await deps.listInstalledV2Packs(ctx.cwd)).map((candidate) => candidate.pack);
    const orch = await deps.orchestrate(ctx.cwd, event.prompt, true, v2packs, ctx.now);
    orchInjections = orch.injections;
    if (orch.activatedPack !== undefined) {
      orchInjections = [
        ...orchInjections,
        `🦑 orchestrator → activated discipline pack \`${orch.activatedPack}\` for this turn (on-demand, task-classified).`,
      ];
    }
  } catch {
    // fail-open — preserve historical prompt flow
  }

  try {
    const settings = await deps.readSettings(ctx.cwd);
    const domain = typeof settings.domain === 'string' ? settings.domain : undefined;
    const facets = classify(event.prompt, {
      project: true,
      ...(domain ? { domain } : {}),
    });
    await deps.writeClassifiedFacets(ctx.sessionId, facets);
  } catch {
    // fail-open — preserve historical lens behavior
  }

  const contextInjections: string[] = [];
  if (inboxEnvelope.length > 0) contextInjections.push(inboxEnvelope);
  contextInjections.push(...dispatchInjections, ...orchInjections);
  if (newProjectLine !== null) contextInjections.push(newProjectLine);
  return {
    exitCode,
    stderr: [stderr, ...diagnostics].filter(Boolean).join('\n'),
    contextInjections,
    directives: dispatched.directives,
    diagnostics,
  };
}
