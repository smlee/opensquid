import { buildRegistry, loadActivePacksForDispatch } from '../../bootstrap.js';
import type { FunctionRegistry } from '../../../functions/registry.js';
import type { Pack } from '../../types.js';
import { runCompression } from '../../compression_orchestrator.js';
import { makeConsolidateRunner } from '../../wedge/compression_deps.js';
import { liveTurnIngestIds } from '../../../rag/memory/store.js';
import { commitMemoryStore } from '../../../rag/store_git.js';
import { createBackend } from '../../../rag/backend_factory.js';
import { resolveBackendConfig } from '../../../rag/config.js';
import { emitProbe, groupFromTask } from '../../satisfaction_probe.js';
import { archiveActiveTask, readActiveTask } from '../../session_state.js';
import { dispatchEvent } from '../dispatch.js';
import { reconcileMemoryOnSessionEnd } from '../memory_reconcile.js';
import { sessionEndIndication } from '../session_end_indication.js';
import { notifyRetentionSweep } from '../session_end_sweep_notify.js';
import { sweepRetiredIfAllowed } from '../session_end_retention.js';
import { reapOrphansIfAllowed } from '../session_end_reap.js';
import { resolveLocalStoreDir } from '../../paths.js';
import { resolveActorId } from '../../actor_id.js';
import { workGraphStore } from '../../../workgraph/store.js';
import { join } from 'node:path';

import type { SessionEndInput, LifecycleContext, LifecycleOutput } from './types.js';

export interface SessionEndHandlerDeps {
  loadDispatch(sessionId: string): Promise<{
    packs: Pack[];
    registry: FunctionRegistry;
  }>;
  dispatchEvent: typeof dispatchEvent;
  readActiveTask: typeof readActiveTask;
  reconcileMemoryOnSessionEnd: typeof reconcileMemoryOnSessionEnd;
  emitProbe: typeof emitProbe;
  runCompression: typeof runCompression;
  makeConsolidateRunner: typeof makeConsolidateRunner;
  liveTurnIngestIds: typeof liveTurnIngestIds;
  createBackend: typeof createBackend;
  resolveBackendConfig: typeof resolveBackendConfig;
  sweepRetiredIfAllowed: typeof sweepRetiredIfAllowed;
  notifyRetentionSweep: typeof notifyRetentionSweep;
  resolveLocalStoreDir: typeof resolveLocalStoreDir;
  resolveActorId: typeof resolveActorId;
  workGraphStore: typeof workGraphStore;
  reapOrphansIfAllowed: typeof reapOrphansIfAllowed;
  commitMemoryStore: typeof commitMemoryStore;
  archiveActiveTask: typeof archiveActiveTask;
}

const DEFAULT_DEPS: SessionEndHandlerDeps = {
  loadDispatch: async (sessionId) => ({
    packs: await loadActivePacksForDispatch(sessionId),
    registry: await buildRegistry(),
  }),
  dispatchEvent,
  readActiveTask,
  reconcileMemoryOnSessionEnd,
  emitProbe,
  runCompression,
  makeConsolidateRunner,
  liveTurnIngestIds,
  createBackend,
  resolveBackendConfig,
  sweepRetiredIfAllowed,
  notifyRetentionSweep,
  resolveLocalStoreDir,
  resolveActorId,
  workGraphStore,
  reapOrphansIfAllowed,
  commitMemoryStore,
  archiveActiveTask,
};

export async function runSessionEnd(
  input: SessionEndInput,
  ctx: LifecycleContext,
  deps: SessionEndHandlerDeps = DEFAULT_DEPS,
): Promise<LifecycleOutput> {
  const diagnostics: string[] = [];
  const { packs, registry } = await deps.loadDispatch(ctx.sessionId);
  const dispatched = await deps.dispatchEvent(input.event, packs, registry, ctx.sessionId);
  if (dispatched.stderr) diagnostics.push(dispatched.stderr);
  if (ctx.role === 'lap-child') {
    return {
      exitCode: dispatched.exitCode,
      stderr: diagnostics.join('\n'),
      contextInjections: dispatched.contextInjections,
      directives: dispatched.directives,
      diagnostics,
    };
  }

  try {
    const ended = await deps.readActiveTask(ctx.sessionId);
    diagnostics.push(sessionEndIndication(ctx.sessionId, ended));
  } catch {
    diagnostics.push(`[opensquid] session ${ctx.sessionId.slice(0, 8)} ended`);
  }

  await deps.reconcileMemoryOnSessionEnd(ctx.sessionId);

  try {
    const active = await deps.readActiveTask(ctx.sessionId);
    const group = groupFromTask(active);
    if (group) await deps.emitProbe(ctx.sessionId, group);
  } catch (error) {
    diagnostics.push(`opensquid: satisfaction-probe emit skipped — ${String(error)}`);
  }

  try {
    const active = await deps.readActiveTask(ctx.sessionId);
    const group = groupFromTask(active);
    if (group) {
      const runner = await deps.makeConsolidateRunner();
      try {
        const outcomes = await deps.runCompression(ctx.sessionId, group, runner.run);
        if (outcomes.length > 0) {
          diagnostics.push(
            `opensquid: compression — ${String(outcomes.length)} window(s) for group ${group}`,
          );
        }
      } finally {
        await runner.close();
      }
    }
  } catch (error) {
    diagnostics.push(`opensquid: compression skipped — ${String(error)}`);
  }

  try {
    const runner = await deps.makeConsolidateRunner();
    try {
      const ids = await deps.liveTurnIngestIds(runner.client);
      const TURN_GIST_WINDOW = 20;
      for (let i = 0; i < ids.length; i += TURN_GIST_WINDOW) {
        await runner.gistAndRetire(ids.slice(i, i + TURN_GIST_WINDOW));
      }
      if (ids.length > 0) {
        diagnostics.push(`opensquid: turn-gist — ${String(ids.length)} raw turn(s) gisted+retired`);
      }
    } finally {
      await runner.close();
    }
  } catch (error) {
    diagnostics.push(`opensquid: turn-gist skipped — ${String(error)}`);
  }

  try {
    const backend = deps.createBackend(await deps.resolveBackendConfig());
    await backend.init();
    const restored = (await backend.repromoteRetiredUserMemories?.()) ?? [];
    if (restored.length > 0) {
      diagnostics.push(`opensquid: retention — ${String(restored.length)} user mem(s) restored`);
    }
    const swept = await deps.sweepRetiredIfAllowed(backend, ctx.cwd);
    if (swept.length > 0) {
      diagnostics.push(`opensquid: retention sweep — ${String(swept.length)} reclaimed`);
      try {
        await deps.notifyRetentionSweep(swept, ctx.cwd);
      } catch {
        // fail-open
      }
    }
  } catch (error) {
    diagnostics.push(`opensquid: retention sweep skipped — ${String(error)}`);
  }

  try {
    const dir = await deps.resolveLocalStoreDir(ctx.cwd);
    const wg = deps.workGraphStore({
      dbUrl: `file:${join(dir, 'workgraph.db')}`,
      sourceDir: join(dir, 'store', 'issues'),
      actorId: await deps.resolveActorId(),
    });
    await wg.init();
    const reaped = await deps.reapOrphansIfAllowed(wg, ctx.cwd);
    if (reaped.length > 0) {
      diagnostics.push(`opensquid: workgraph reaper — ${String(reaped.length)} orphan(s) archived`);
    }
  } catch (error) {
    diagnostics.push(`opensquid: workgraph reap skipped — ${String(error)}`);
  }

  try {
    const sha = await deps.commitMemoryStore(
      `memory snapshot: session ${ctx.sessionId.slice(0, 8)}`,
    );
    if (sha !== null) diagnostics.push(`opensquid: memory-store snapshot ${sha}`);
  } catch {
    // fail-soft
  }

  if (input.isLoopLap) {
    diagnostics.push('opensquid: auto-handoff skipped — headless ralph lap (OPENSQUID_LOOP_LAP)');
  } else {
    try {
      const { hasResumableState } = await import('../../handoff/substance.js');
      if (await hasResumableState(ctx.sessionId)) {
        const { runHandoff } = await import('../../handoff/index.js');
        const result = await runHandoff(ctx.sessionId, ctx.cwd);
        diagnostics.push(`opensquid: auto-handoff written — ${result.docPath}`);
      } else {
        diagnostics.push('opensquid: auto-handoff skipped — no resumable state');
      }
    } catch (error) {
      diagnostics.push(`opensquid: auto-handoff skipped — ${String(error)}`);
    }
  }

  await deps.archiveActiveTask(ctx.sessionId);

  return {
    exitCode: dispatched.exitCode,
    stderr: diagnostics.join('\n'),
    contextInjections: [],
    directives: dispatched.directives,
    diagnostics,
  };
}
