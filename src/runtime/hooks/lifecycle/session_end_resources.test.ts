import { describe, expect, it, vi } from 'vitest';

import { FunctionRegistry } from '../../../functions/registry.js';
import type { RagBackend } from '../../../rag/types.js';
import { runSessionEnd, type SessionEndHandlerDeps } from './session_end.js';
import type { LifecycleContext } from './types.js';

const resolved = <T>(value: T) => vi.fn(() => Promise.resolve(value));

function backend() {
  const init = vi.fn(() => Promise.resolve());
  const close = vi.fn(() => Promise.resolve());
  const value: RagBackend = {
    init,
    close,
    embed: resolved(null),
    recall: resolved([]),
    storeLesson: resolved(undefined),
    deleteLesson: resolved({ deleted: false, forced: false }),
    repromoteRetiredUserMemories: resolved([]),
  };
  return { value, init, close };
}

function deps(createdBackend: RagBackend): SessionEndHandlerDeps {
  return {
    loadDispatch: resolved({ packs: [], registry: new FunctionRegistry() }),
    dispatchEvent: resolved({
      exitCode: 0 as const,
      stderr: '',
      contextInjections: [],
      directives: [],
    }),
    readActiveTask: resolved(null),
    reconcileMemoryOnSessionEnd: resolved(undefined),
    emitProbe: resolved(undefined),
    runCompression: resolved([]),
    makeConsolidateRunner: vi.fn(() =>
      Promise.resolve({
        run: vi.fn(),
        close: resolved(undefined),
        gistAndRetire: resolved(undefined),
        client: {} as never,
      }),
    ),
    liveTurnIngestIds: resolved([]),
    createBackend: vi.fn(() => createdBackend),
    resolveBackendConfig: resolved({} as never),
    sweepRetiredIfAllowed: resolved([]),
    notifyRetentionSweep: resolved(undefined),
    resolveLocalStoreDir: resolved('/repo/.opensquid'),
    resolveActorId: resolved('actor-1'),
    workGraphStore: vi.fn(() => ({ init: resolved(undefined) }) as never),
    reapOrphansIfAllowed: resolved([]),
    commitMemoryStore: resolved(null),
    archiveActiveTask: resolved(undefined),
  };
}

function context(overrides: Partial<LifecycleContext> = {}): LifecycleContext {
  return {
    sessionId: 'session-resource-test',
    cwd: '/repo',
    actor: { kind: 'coordinator' },
    role: 'interactive',
    now: '2026-07-14T00:00:00.000Z',
    ...overrides,
  };
}

describe('session-end runtime resource ownership', () => {
  it('reuses the runtime-owned registry/backend without initializing or closing it', async () => {
    const shared = backend();
    const registry = new FunctionRegistry();
    const injected = deps(backend().value);
    const loadDispatch = vi.spyOn(injected, 'loadDispatch');

    await runSessionEnd(
      { event: { kind: 'session_end', sessionId: 'session-resource-test' }, isLoopLap: false },
      context({ registry, ragBackend: shared.value }),
      injected,
    );

    expect(loadDispatch).toHaveBeenCalledWith('session-resource-test', registry);
    expect(injected.createBackend).not.toHaveBeenCalled();
    expect(shared.init).not.toHaveBeenCalled();
    expect(shared.close).not.toHaveBeenCalled();
  });

  it('initializes and closes an ephemeral retention backend when no runtime owner is supplied', async () => {
    const ephemeral = backend();
    const injected = deps(ephemeral.value);

    await runSessionEnd(
      { event: { kind: 'session_end', sessionId: 'session-resource-test' }, isLoopLap: false },
      context(),
      injected,
    );

    expect(injected.createBackend).toHaveBeenCalledTimes(1);
    expect(ephemeral.init).toHaveBeenCalledTimes(1);
    expect(ephemeral.close).toHaveBeenCalledTimes(1);
  });
});
