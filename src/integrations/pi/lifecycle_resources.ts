import { createBackend, type BackendConfig } from '../../rag/backend_factory.js';
import { resolveBackendConfig } from '../../rag/config.js';
import type { RagBackend } from '../../rag/types.js';
import { wedgeLessonsDbUrl, wedgeLessonsDir } from '../../rag/wedge/paths.js';
import { wedgeLessonStore, type WedgeLessonStore } from '../../rag/wedge/store.js';
import { buildRegistry, type BuildRegistryOpts } from '../../runtime/bootstrap.js';
import type { FunctionRegistry } from '../../functions/registry.js';

export interface PiLifecycleResources {
  registry: FunctionRegistry;
  ragBackend: RagBackend;
}

export interface PiLifecycleResourceOwner {
  get(): Promise<PiLifecycleResources>;
  close(): Promise<void>;
}

interface ResourceOwnerDeps {
  resolveBackendConfig(): Promise<BackendConfig>;
  createBackend(config: BackendConfig): RagBackend;
  createLessonStore(): WedgeLessonStore;
  buildRegistry(opts: BuildRegistryOpts): Promise<FunctionRegistry>;
}

const DEFAULT_DEPS: ResourceOwnerDeps = {
  resolveBackendConfig,
  createBackend,
  createLessonStore: () =>
    wedgeLessonStore({ dbUrl: wedgeLessonsDbUrl(), sourceDir: wedgeLessonsDir() }),
  buildRegistry,
};

/**
 * Own the one registry/RAG backend pair used by a Pi extension runtime.
 *
 * `get()` is single-flight so parallel lifecycle events cannot initialize duplicate native libSQL clients.
 * `close()` is idempotent, waits for an in-flight initialization, and closes the backend exactly once.
 * A Pi reload discards this owner with the old extension instance; the new extension gets a fresh owner.
 */
export function createPiLifecycleResourceOwner(
  deps: ResourceOwnerDeps = DEFAULT_DEPS,
): PiLifecycleResourceOwner {
  type OwnedResources = PiLifecycleResources & { lessonStore: WedgeLessonStore };
  let resourcesPromise: Promise<OwnedResources> | undefined;
  let publicResourcesPromise: Promise<PiLifecycleResources> | undefined;
  let closePromise: Promise<void> | undefined;
  let closed = false;

  const initialize = async (): Promise<OwnedResources> => {
    const ragBackend = deps.createBackend(await deps.resolveBackendConfig());
    const lessonStore = deps.createLessonStore();
    try {
      const registry = await deps.buildRegistry({ backend: ragBackend, lessonStore });
      return { registry, ragBackend, lessonStore };
    } catch (error) {
      await Promise.all([
        ragBackend.close?.().catch(() => undefined),
        lessonStore.close?.().catch(() => undefined),
      ]);
      throw error;
    }
  };

  return {
    get() {
      if (closed) return Promise.reject(new Error('OpenSquid Pi lifecycle resources are closed'));
      resourcesPromise ??= initialize();
      publicResourcesPromise ??= resourcesPromise.then(({ registry, ragBackend }) => ({
        registry,
        ragBackend,
      }));
      return publicResourcesPromise;
    },
    close() {
      if (closePromise !== undefined) return closePromise;
      closed = true;
      closePromise = (async () => {
        if (resourcesPromise === undefined) return;
        const resources = await resourcesPromise.catch(() => undefined);
        if (resources === undefined) return;
        await Promise.all([resources.ragBackend.close?.(), resources.lessonStore.close?.()]);
      })();
      return closePromise;
    },
  };
}
