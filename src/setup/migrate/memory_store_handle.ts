/**
 * MemoryStore handle for the auto-memory sync (retire-Rust RES-5b). The auto-memory consumers
 * (importer / drift / reconcile / CLI / doctor) drove `EngineClient.memory*`; this handle re-points
 * those ops onto the libSQL memory store (RES-5a `src/rag/memory/store.ts`). It abstracts exactly the
 * five ops the importer + drift need, so those functions stay store-agnostic and the consumers just
 * build + close the handle.
 *
 * libSQL memory is content-only: the engine's separate `description` + `content` fold into one
 * content field (`description\n\nbody`, per migrate_memories) — `folded` is the single helper used by
 * BOTH the importer's refresh-compare AND drift's disk-side comparison (re-pointing only the read op
 * would leave drift comparing folded-vs-bare → every import reports STALE). The import marker is the
 * `origin:import:<name>` tag (libSQL has no `origin` column).
 *
 * Imports from: @libsql/client, node:crypto, ../../rag/backend_factory.js, ../../rag/config.js,
 *   ../../rag/memory/store.js.
 * Imported by: auto_memory_importer / memory_drift / auto_memory_snapshot / memory_reconcile /
 *   cli/memory / cli/doctor.
 */
import { createHash } from 'node:crypto';

import { createClient } from '@libsql/client';

import { createBackend } from '../../rag/backend_factory.js';
import { resolveBackendConfig } from '../../rag/config.js';
import {
  ensureCompressionColumns,
  getMemoryById,
  insertMemory,
  listMemories,
  updateMemory,
  IMPORT_TAG_PREFIX,
} from '../../rag/memory/store.js';

/** Fold the engine's separate description + body into the libSQL content-only field. */
export const folded = (description: string, body: string): string => `${description}\n\n${body}`;

export interface MemoryStore {
  create(input: {
    name: string;
    description: string;
    body: string;
    scope: string;
  }): Promise<{ id: string }>;
  get(id: string): Promise<{ content: string } | null>;
  update(id: string, input: { description: string; body: string; scope: string }): Promise<void>;
  /** name → {id} for every imported memory (the `origin:import:` tag), via paged listMemories. */
  listImportIndex(): Promise<Map<string, { id: string }>>;
  delete(id: string): Promise<void>;
  close(): Promise<void>;
}

/** Build a MemoryStore over the live backend + a libSQL client. The caller `close()`s it. */
export async function makeMemoryStore(): Promise<MemoryStore> {
  const cfg = await resolveBackendConfig();
  if (!('dbUrl' in cfg)) throw new Error(`auto-memory: backend "${cfg.kind}" has no dbUrl`);
  const dbUrl = cfg.dbUrl;
  // File-first source-of-truth (fastembed variant only) so imported memories are durable across a
  // rebuildLibsqlIndex — see T-fix-compression-durability.
  const sourceDir = 'sourceDir' in cfg ? cfg.sourceDir : undefined;
  const backend = createBackend(cfg);
  await backend.init();
  const client = createClient({ url: dbUrl });
  await ensureCompressionColumns(client);
  const nowIso = (): string => new Date().toISOString();

  return {
    async create({ name, description, body, scope }) {
      const content = folded(description, body);
      const id = `mem-${createHash('sha256').update(`${name}\n${content}`).digest('hex').slice(0, 16)}`;
      const embedding = await backend.embed(content);
      await insertMemory(
        client,
        {
          id,
          content,
          tags: [`scope:${scope}`, `${IMPORT_TAG_PREFIX}${name}`],
          source: 'memory',
          author: 'user',
          createdAt: nowIso(),
          derivedFrom: [],
          consumedByUserLessons: 0,
          embedding,
        },
        sourceDir,
      );
      return { id };
    },
    get: (id) =>
      getMemoryById(client, id).then((m) => (m === null ? null : { content: m.content })),
    update: (id, { description, body, scope }) =>
      updateMemory(client, (t) => backend.embed(t), {
        id,
        content: folded(description, body),
        scope,
      }),
    async listImportIndex() {
      const index = new Map<string, { id: string }>();
      const pageSize = 200;
      let offset = 0;
      for (let i = 0; i < 1000; i++) {
        const page = await listMemories(client, { limit: pageSize, offset });
        for (const row of page.results) {
          const tag = row.tags.find((t) => t.startsWith(IMPORT_TAG_PREFIX));
          if (tag !== undefined) index.set(tag.slice(IMPORT_TAG_PREFIX.length), { id: row.id });
        }
        if (page.returned < pageSize) break;
        offset += page.returned;
      }
      return index;
    },
    delete: (id) => backend.deleteLesson(id, { force: true }).then(() => undefined),
    close: () => {
      client.close();
      return Promise.resolve();
    },
  };
}
