/**
 * Memory-store accessors for compression (retire-Rust RES-4a). The memory store IS the libSQL
 * `lessons` table (source:'memory'); compression needs two things the base store
 * (src/rag/backends/libsql_store.ts) doesn't expose: a get-by-id and an insert that carries the two
 * compression columns (`derived_from`, `consumed_by_user_lessons`). These are added ADDITIVELY via
 * `ensureCompressionColumns` (idempotent `ALTER TABLE ADD COLUMN` — existing rows default, so the
 * RES-1/3 recall/memorize paths are unaffected). Kept here (not in libsql_store) so the memory-
 * compression concern stays cohesive and the base backend's private client is untouched.
 *
 * Imports from: @libsql/client, ./compress.js.
 * Imported by: RES-4b (consolidate wires compress's getMemoryById/insertMemory deps) — not yet wired.
 */
import type { Client } from '@libsql/client';

import type { MemoryRow } from './compress.js';

/** Idempotently add the two compression columns to an existing `lessons` table. */
export async function ensureCompressionColumns(client: Client): Promise<void> {
  for (const ddl of [
    `ALTER TABLE lessons ADD COLUMN derived_from TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE lessons ADD COLUMN consumed_by_user_lessons INTEGER NOT NULL DEFAULT 0`,
  ]) {
    try {
      await client.execute(ddl);
    } catch {
      // duplicate-column = already migrated; any other error surfaces on the SELECT/INSERT below.
    }
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number =>
  typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : 0;

function rowToMemory(row: Record<string, unknown>): MemoryRow {
  return {
    id: str(row.id),
    content: str(row.content),
    tags: JSON.parse(str(row.tags) || '[]') as string[],
    source: str(row.source),
    author: str(row.author) === 'user' ? 'user' : 'agent',
    createdAt: str(row.created_at),
    derivedFrom: JSON.parse(str(row.derived_from) || '[]') as string[],
    consumedByUserLessons: num(row.consumed_by_user_lessons),
  };
}

/** Load one memory by id (the `lessons` row), or null. */
export async function getMemoryById(client: Client, id: string): Promise<MemoryRow | null> {
  const rs = await client.execute({
    sql: `SELECT id, content, tags, source, author, created_at, derived_from, consumed_by_user_lessons
          FROM lessons WHERE id = ?`,
    args: [id],
  });
  if (rs.rows.length === 0) return null;
  return rowToMemory(rs.rows[0] as unknown as Record<string, unknown>);
}

/** Insert a memory carrying the compression columns (+ FTS + optional vector). Idempotent upsert by id. */
export async function insertMemory(client: Client, m: MemoryRow): Promise<void> {
  const tagsJson = JSON.stringify(m.tags);
  const vec = m.embedding ?? null;
  await client.execute({ sql: `DELETE FROM lessons WHERE id = ?`, args: [m.id] });
  await client.execute({ sql: `DELETE FROM lessons_fts WHERE id = ?`, args: [m.id] });
  await client.execute({
    sql: `INSERT INTO lessons (id, content, tags, source, author, created_at, derived_from,
          consumed_by_user_lessons, embedding)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${vec ? 'vector32(?)' : 'NULL'})`,
    args: vec
      ? [
          m.id,
          m.content,
          tagsJson,
          m.source,
          m.author,
          m.createdAt,
          JSON.stringify(m.derivedFrom),
          m.consumedByUserLessons,
          JSON.stringify(vec),
        ]
      : [
          m.id,
          m.content,
          tagsJson,
          m.source,
          m.author,
          m.createdAt,
          JSON.stringify(m.derivedFrom),
          m.consumedByUserLessons,
        ],
  });
  await client.execute({
    sql: `INSERT INTO lessons_fts (id, content, tags, source) VALUES (?, ?, ?, ?)`,
    args: [m.id, m.content, tagsJson, m.source],
  });
}

/** The auto-memory import marker, as a tag (libSQL has no `origin` column): `origin:import:<name>`. */
export const IMPORT_TAG_PREFIX = 'origin:import:';

export interface ListMemoriesResult {
  results: MemoryRow[];
  returned: number;
  total: number;
}

/** Paged list of memory rows in a deterministic order, each carrying its tags (the import marker). */
export async function listMemories(
  client: Client,
  opts: { limit: number; offset: number },
): Promise<ListMemoriesResult> {
  const totalRs = await client.execute(`SELECT COUNT(*) AS n FROM lessons`);
  const total = num(totalRs.rows[0]?.n);
  const rs = await client.execute({
    sql: `SELECT id, content, tags, source, author, created_at, derived_from, consumed_by_user_lessons
          FROM lessons ORDER BY created_at, id LIMIT ? OFFSET ?`,
    args: [opts.limit, opts.offset],
  });
  const results = rs.rows.map((r) => rowToMemory(r as unknown as Record<string, unknown>));
  return { results, returned: results.length, total };
}

/**
 * Update a memory's content (the folded `description\n\nbody`) + its `scope:` tag, re-embedding via
 * `embed`. Preserves every OTHER tag (incl. the `origin:import:` marker) + derived_from/counters by
 * loading the row and reusing the file-first `insertMemory` upsert. Throws if the id is absent.
 */
export async function updateMemory(
  client: Client,
  embed: (text: string) => Promise<number[] | null>,
  opts: { id: string; content: string; scope?: string },
): Promise<void> {
  const row = await getMemoryById(client, opts.id);
  if (row === null) throw new Error(`updateMemory: ${opts.id} not found`);
  const tags = row.tags.filter((t) => !t.startsWith('scope:')); // replace, don't append
  if (opts.scope !== undefined) tags.push(`scope:${opts.scope}`);
  const embedding = await embed(opts.content);
  await insertMemory(client, { ...row, content: opts.content, tags, embedding });
}
