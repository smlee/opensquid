import { describe, expect, it, vi } from 'vitest';

import { FunctionRegistry } from '../../functions/registry.js';
import type { RagBackend } from '../../rag/types.js';
import type { WedgeLessonStore } from '../../rag/wedge/store.js';
import { createPiLifecycleResourceOwner } from './lifecycle_resources.js';

function lessonStore(close: () => Promise<void>): WedgeLessonStore {
  return {
    init: vi.fn(() => Promise.resolve()),
    close,
    createLesson: vi.fn(() => Promise.reject(new Error('unused'))),
    promoteLesson: vi.fn(() => Promise.reject(new Error('unused'))),
    recallLesson: vi.fn(() => Promise.resolve({ query: '', returned: 0, results: [] })),
    captureFeedback: vi.fn(() => Promise.resolve()),
    recordApplied: vi.fn(() => Promise.resolve()),
    rebuild: vi.fn(() => Promise.resolve({ indexed: 0 })),
  };
}

function backend(close: () => Promise<void>): RagBackend {
  return {
    init: vi.fn(() => Promise.resolve()),
    close,
    embed: vi.fn(() => Promise.resolve(null)),
    recall: vi.fn(() => Promise.resolve([])),
    storeLesson: vi.fn(() => Promise.resolve()),
    deleteLesson: vi.fn(() => Promise.resolve({ deleted: false, forced: false })),
  };
}

describe('Pi lifecycle resource owner', () => {
  it('single-flights one registry/backend pair and closes it exactly once', async () => {
    const ragClose = vi.fn(() => Promise.resolve());
    const lessonClose = vi.fn(() => Promise.resolve());
    const ragBackend = backend(ragClose);
    const ownedLessonStore = lessonStore(lessonClose);
    const registry = new FunctionRegistry();
    const resolveBackendConfig = vi.fn(() =>
      Promise.resolve({ kind: 'libsql-lexical' as const, dbUrl: 'file:test.db' }),
    );
    const createBackend = vi.fn(() => ragBackend);
    const createLessonStore = vi.fn(() => ownedLessonStore);
    const buildRegistry = vi.fn(() => Promise.resolve(registry));
    const owner = createPiLifecycleResourceOwner({
      resolveBackendConfig,
      createBackend,
      createLessonStore,
      buildRegistry,
    });

    const [first, second] = await Promise.all([owner.get(), owner.get()]);
    expect(first).toBe(second);
    expect(first).toEqual({ registry, ragBackend });
    expect(resolveBackendConfig).toHaveBeenCalledTimes(1);
    expect(createBackend).toHaveBeenCalledTimes(1);
    expect(createLessonStore).toHaveBeenCalledTimes(1);
    expect(buildRegistry).toHaveBeenCalledTimes(1);
    expect(buildRegistry).toHaveBeenCalledWith({
      backend: ragBackend,
      lessonStore: ownedLessonStore,
    });

    await Promise.all([owner.close(), owner.close()]);
    expect(ragClose).toHaveBeenCalledTimes(1);
    expect(lessonClose).toHaveBeenCalledTimes(1);
    await expect(owner.get()).rejects.toThrow(/resources are closed/u);
  });

  it('closes resources whose registry initialization fails', async () => {
    const ragClose = vi.fn(() => Promise.resolve());
    const lessonClose = vi.fn(() => Promise.resolve());
    const ragBackend = backend(ragClose);
    const ownedLessonStore = lessonStore(lessonClose);
    const owner = createPiLifecycleResourceOwner({
      resolveBackendConfig: () =>
        Promise.resolve({ kind: 'libsql-lexical' as const, dbUrl: 'file:test.db' }),
      createBackend: () => ragBackend,
      createLessonStore: () => ownedLessonStore,
      buildRegistry: () => Promise.reject(new Error('init failed')),
    });

    await expect(owner.get()).rejects.toThrow('init failed');
    expect(ragClose).toHaveBeenCalledTimes(1);
    expect(lessonClose).toHaveBeenCalledTimes(1);
    await expect(owner.close()).resolves.toBeUndefined();
    expect(ragClose).toHaveBeenCalledTimes(1);
    expect(lessonClose).toHaveBeenCalledTimes(1);
  });
});
