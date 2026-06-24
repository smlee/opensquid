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

import { writeRecord } from '../backends/perfile_source.js';

import type { MemoryRow } from './compress.js';

/** Idempotently add the two compression columns to an existing `lessons` table. */
export async function ensureCompressionColumns(client: Client): Promise<void> {
  for (const ddl of [
    `ALTER TABLE lessons ADD COLUMN derived_from TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE lessons ADD COLUMN consumed_by_user_lessons INTEGER NOT NULL DEFAULT 0`,
    // Scope columns (T-memory-scope-isolation) — additive, idempotent, same as the compression cols.
    `ALTER TABLE lessons ADD COLUMN tier TEXT NOT NULL DEFAULT 'shared'`,
    `ALTER TABLE lessons ADD COLUMN namespace TEXT`,
    // Durability axis (wg-4f91e0b5cb8c) — additive, idempotent.
    `ALTER TABLE lessons ADD COLUMN durability TEXT`,
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
    tier: str(row.tier) === 'project' ? 'project' : 'shared',
    namespace: typeof row.namespace === 'string' ? row.namespace : null,
    ...(row.durability === 'durable' || row.durability === 'point_in_time'
      ? { durability: row.durability }
      : {}),
  };
}

/** Load one memory by id (the `lessons` row), or null. */
export async function getMemoryById(client: Client, id: string): Promise<MemoryRow | null> {
  const rs = await client.execute({
    sql: `SELECT id, content, tags, source, author, created_at, derived_from, consumed_by_user_lessons, tier, namespace, durability
          FROM lessons WHERE id = ?`,
    args: [id],
  });
  if (rs.rows.length === 0) return null;
  return rowToMemory(rs.rows[0] as unknown as Record<string, unknown>);
}

/**
 * Raw turn-ingest rows eligible for gisting at session-end: assistant/tool only (user prose `author:'user'`
 * is verbatim + immune and excluded), live (un-retired), AND not already captured in an EMBEDDED gist's
 * `derived_from` (the re-gist guard — a turn whose gist embedded is never re-gisted; a turn whose gist
 * embed FAILED has only a null-embedding gist, so it stays eligible and is re-attempted). `derived_from`
 * is a JSON-array TEXT column, queried via SQLite `json_each`.
 */
export async function liveTurnIngestIds(client: Client): Promise<string[]> {
  const rs = await client.execute(
    `SELECT id FROM lessons
       WHERE source = 'turn-ingest' AND author != 'user' AND retired_at IS NULL
         AND id NOT IN (
           SELECT je.value FROM lessons g, json_each(g.derived_from) je
           WHERE g.embedding IS NOT NULL AND g.derived_from IS NOT NULL AND g.derived_from != '[]'
         )
       ORDER BY created_at ASC`,
  );
  return rs.rows.map((r) => str(r.id));
}

/** ALL turn-ingest ids (incl. `author:'user'` + retired) — for the one-time `memory clean-turns` cleanup. */
export async function allTurnIngestIds(client: Client): Promise<string[]> {
  const rs = await client.execute(`SELECT id FROM lessons WHERE source = 'turn-ingest'`);
  return rs.rows.map((r) => str(r.id));
}

/**
 * Insert a memory carrying the compression columns (+ FTS + optional vector). Idempotent upsert by id.
 * File-first when `sourceDir` is given: writes the per-file source-of-truth (atomic) BEFORE the DB
 * upsert, mirroring `storeLesson` — so a consolidated memory survives a `rebuildLibsqlIndex` (which
 * re-indexes from files only). `sourceDir` undefined → DB-only (the pre-existing behavior).
 */
export async function insertMemory(
  client: Client,
  m: MemoryRow,
  sourceDir?: string,
): Promise<void> {
  if (sourceDir !== undefined) await writeRecord(sourceDir, m);
  const tagsJson = JSON.stringify(m.tags);
  const vec = m.embedding ?? null;
  await client.execute({ sql: `DELETE FROM lessons WHERE id = ?`, args: [m.id] });
  await client.execute({ sql: `DELETE FROM lessons_fts WHERE id = ?`, args: [m.id] });
  const tier = m.tier ?? 'shared';
  const namespace = m.namespace ?? null;
  const durability = m.durability ?? null;
  await client.execute({
    sql: `INSERT INTO lessons (id, content, tags, source, author, created_at, derived_from,
          consumed_by_user_lessons, tier, namespace, durability, embedding)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${vec ? 'vector32(?)' : 'NULL'})`,
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
          tier,
          namespace,
          durability,
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
          tier,
          namespace,
          durability,
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
