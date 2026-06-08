/**
 * Wedge-gate lesson lifecycle store (retire-Rust RES-3b). The TS/libSQL replacement for the engine's
 * `lesson.*` RPC: a dedicated `wg_lessons` table + FTS + per-file source (status-dir, src/rag/wedge/
 * source.ts) holding the lesson lifecycle (pending → promoted/...). `promoteLesson` runs the RES-3a
 * pure gate (`./gate.ts`); a block throws `PromotionBlockedError` (RES-3c maps it to
 * `{status:'blocked', reasons}`). This is SEPARATE from the memory/RAG `lessons` table.
 *
 * MOAT INVARIANT (handed over by RES-3a): `created_at` is STORE-OWNED — set on insert from the store
 * clock, NEVER caller-supplied. RES-3a dropped the filesystem-birthtime TamperedAge check; the 24h
 * time-floor it still enforces is only backdate-proof because the store owns the timestamp.
 *
 * Imports from: @libsql/client, node:crypto, ./gate.js, ./source.js, ../backends/libsql_store.js.
 * Imported by: RES-3c (lessons.ts / store-lesson.ts / bootstrap.ts) — not yet wired.
 */
import { createHash } from 'node:crypto';

import { createClient, type Client } from '@libsql/client';

import { ftsEscape } from '../backends/libsql_store.js';

import {
  checkPromotionGate,
  type CausalNarrative,
  type LessonFrontmatter,
  type LessonStatus,
} from './gate.js';
import { writeWedgeRecord, deleteWedgeRecord, MAX_APPLIED_SESSION_IDS } from './source.js';

/** Thrown by `promoteLesson` when the gate blocks. `reasons` are the kebab-prefix block strings. */
export class PromotionBlockedError extends Error {
  constructor(
    public readonly id: string,
    public readonly reasons: string[],
  ) {
    super(`Lesson ${id} promotion blocked: ${reasons.join('; ')}`);
    this.name = 'PromotionBlockedError';
  }
}

/** A wedge lesson row. WIDENS the gate's `LessonFrontmatter` (which lacks `thumbsUpCount`). */
export interface WedgeLesson extends LessonFrontmatter {
  id: string;
  description: string;
  body: string;
  authoredBy: 'user' | 'agent' | 'pack';
  packId?: string;
  externalId?: string;
  thumbsUpCount: number;
  updatedAt: string;
  promotedAt?: string;
  lastAppliedAt?: string;
}

export interface CreateLessonInput {
  description: string;
  body: string;
  evidenceRefs?: string[];
  authoredBy?: 'user' | 'agent' | 'pack';
}

export interface WedgeRecallHit {
  kind: 'lesson';
  id: string;
  description: string;
  status: LessonStatus;
  body_preview: string;
  similarity: number;
  applied_count: number;
}

export interface WedgeLessonStore {
  init(): Promise<void>;
  createLesson(
    input: CreateLessonInput,
  ): Promise<{ id: string; status: 'pending'; createdAt: string }>;
  promoteLesson(id: string): Promise<{ id: string; status: 'promoted' }>;
  recallLesson(
    query: string,
    limit?: number,
  ): Promise<{ query: string; returned: number; results: WedgeRecallHit[] }>;
  captureFeedback(id: string, polarity: 'up' | 'down', signalId: string): Promise<void>;
  recordApplied(id: string, sessionId?: string): Promise<void>;
  /** Clean DB-index rebuild from already-on-disk records (migration; no file rewrite). */
  rebuild(records: WedgeLesson[]): Promise<{ indexed: number }>;
}

export function wedgeLessonStore(opts: {
  dbUrl: string;
  sourceDir: string;
  nowIso?: () => string;
}): WedgeLessonStore {
  let client: Client | null = null;
  const now = opts.nowIso ?? (() => new Date().toISOString());
  const db = (): Client => {
    if (!client) throw new Error('wedge-store: not initialized');
    return client;
  };

  // The moat-critical projection: row → the exact LessonFrontmatter the gate reads.
  const toFrontmatter = (r: WedgeLesson): LessonFrontmatter => ({
    status: r.status,
    ...(r.supersededAt !== undefined ? { supersededAt: r.supersededAt } : {}),
    createdAt: r.createdAt,
    appliedCount: r.appliedCount,
    thumbsDownCount: r.thumbsDownCount,
    externalSignalSources: r.externalSignalSources,
    appliedSessionIds: r.appliedSessionIds,
    ...(r.causalNarrative !== undefined ? { causalNarrative: r.causalNarrative } : {}),
  });

  // typeof-guarded coercion (libsql Values are unknown-typed; no String()/Number() on unknown).
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const sopt = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length > 0 ? v : undefined;
  const num = (v: unknown): number =>
    typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : 0;

  const rowToWedge = (row: Record<string, unknown>): WedgeLesson => {
    const packId = sopt(row.pack_id);
    const externalId = sopt(row.external_id);
    const promotedAt = sopt(row.promoted_at);
    const supersededAt = sopt(row.superseded_at);
    const lastAppliedAt = sopt(row.last_applied_at);
    const cn = str(row.causal_narrative);
    return {
      id: str(row.id),
      description: str(row.description),
      body: str(row.body),
      status: str(row.status) as LessonStatus,
      authoredBy: (str(row.authored_by) || 'agent') as 'user' | 'agent' | 'pack',
      ...(packId !== undefined ? { packId } : {}),
      ...(externalId !== undefined ? { externalId } : {}),
      createdAt: str(row.created_at),
      updatedAt: str(row.updated_at),
      ...(promotedAt !== undefined ? { promotedAt } : {}),
      ...(supersededAt !== undefined ? { supersededAt } : {}),
      ...(lastAppliedAt !== undefined ? { lastAppliedAt } : {}),
      appliedCount: num(row.applied_count),
      thumbsUpCount: num(row.thumbs_up_count),
      thumbsDownCount: num(row.thumbs_down_count),
      externalSignalSources: JSON.parse(str(row.external_signal_sources) || '[]') as string[],
      appliedSessionIds: JSON.parse(str(row.applied_session_ids) || '[]') as string[],
      ...(cn !== '' ? { causalNarrative: JSON.parse(cn) as CausalNarrative } : {}),
    };
  };

  const read = async (id: string): Promise<WedgeLesson> => {
    const rs = await db().execute({ sql: `SELECT * FROM wg_lessons WHERE id = ?`, args: [id] });
    if (rs.rows.length === 0) throw new Error(`wedge-store: lesson ${id} not found`);
    return rowToWedge(rs.rows[0] as unknown as Record<string, unknown>);
  };

  // The table + FTS insert for one row — shared by upsert (file-first write path) and rebuild
  // (DB-only migration path). One INSERT definition so the moat-shaped column list can't drift.
  const dbInsert = async (c: Client, r: WedgeLesson): Promise<void> => {
    await c.execute({
      sql: `INSERT INTO wg_lessons (id, description, body, status, authored_by, pack_id, external_id,
        created_at, updated_at, promoted_at, superseded_at, last_applied_at, applied_count,
        thumbs_up_count, thumbs_down_count, external_signal_sources, applied_session_ids, causal_narrative)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        r.id,
        r.description,
        r.body,
        r.status,
        r.authoredBy,
        r.packId ?? null,
        r.externalId ?? null,
        r.createdAt,
        r.updatedAt,
        r.promotedAt ?? null,
        r.supersededAt ?? null,
        r.lastAppliedAt ?? null,
        r.appliedCount,
        r.thumbsUpCount,
        r.thumbsDownCount,
        JSON.stringify(r.externalSignalSources),
        JSON.stringify(r.appliedSessionIds),
        r.causalNarrative ? JSON.stringify(r.causalNarrative) : null,
      ],
    });
    await c.execute({
      sql: `INSERT INTO wg_lessons_fts (id, description, body) VALUES (?,?,?)`,
      args: [r.id, r.description, r.body],
    });
  };

  // Idempotent upsert: FILE-FIRST (writeWedgeRecord derives the status-dir from row.status, so the
  // new-status file lands before the DB), then delete-then-insert across table + FTS.
  const upsert = async (r: WedgeLesson): Promise<void> => {
    await writeWedgeRecord(opts.sourceDir, r);
    const c = db();
    await c.execute({ sql: `DELETE FROM wg_lessons WHERE id = ?`, args: [r.id] });
    await c.execute({ sql: `DELETE FROM wg_lessons_fts WHERE id = ?`, args: [r.id] });
    await dbInsert(c, r);
  };

  return {
    async init() {
      client = createClient({ url: opts.dbUrl });
      await client.execute(`CREATE TABLE IF NOT EXISTS wg_lessons (
        id TEXT PRIMARY KEY, description TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL,
        authored_by TEXT NOT NULL, pack_id TEXT, external_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, promoted_at TEXT, superseded_at TEXT,
        last_applied_at TEXT, applied_count INTEGER NOT NULL DEFAULT 0,
        thumbs_up_count INTEGER NOT NULL DEFAULT 0, thumbs_down_count INTEGER NOT NULL DEFAULT 0,
        external_signal_sources TEXT NOT NULL DEFAULT '[]', applied_session_ids TEXT NOT NULL DEFAULT '[]',
        causal_narrative TEXT
      );`);
      await client.execute(`CREATE VIRTUAL TABLE IF NOT EXISTS wg_lessons_fts
        USING fts5(id UNINDEXED, description, body);`);
    },

    async createLesson(input) {
      const createdAt = now(); // STORE-OWNED — caller-supplied created_at is IGNORED (moat invariant)
      const id = `les-${createHash('sha256')
        .update(input.description + '\n' + input.body)
        .digest('hex')
        .slice(0, 16)}`;
      // pack `seedAsPromoted` (create directly into promoted/) is OUT OF SCOPE here — pack seed-ingest
      // is dead (RES-1). All createLesson → pending.
      const row: WedgeLesson = {
        id,
        description: input.description,
        body: input.body,
        status: 'pending',
        authoredBy: input.authoredBy ?? 'agent',
        createdAt,
        updatedAt: createdAt,
        appliedCount: 0,
        thumbsUpCount: 0,
        thumbsDownCount: 0,
        externalSignalSources: [],
        appliedSessionIds: [],
        ...(input.evidenceRefs && input.evidenceRefs.length > 0
          ? {
              causalNarrative: {
                confidence: 'inferred' as const,
                evidenceRefs: input.evidenceRefs,
              },
            }
          : {}),
      };
      await upsert(row);
      return { id, status: 'pending', createdAt };
    },

    async promoteLesson(id) {
      const row = await read(id);
      // Use the STORE clock for the gate's `now` (not real time) — consistent with the store-owned
      // created_at the 24h floor checks against, and deterministic under the nowIso seam.
      const decision = checkPromotionGate(toFrontmatter(row), undefined, new Date(now()));
      if (decision.kind === 'block') throw new PromotionBlockedError(id, decision.reasons);
      const t = now();
      const promoted: WedgeLesson = { ...row, status: 'promoted', promotedAt: t, updatedAt: t };
      await upsert(promoted); // writes promoted/<id>.md + DB FIRST
      if (row.status !== 'promoted') await deleteWedgeRecord(opts.sourceDir, row.status, id); // THEN remove old-status file
      return { id, status: 'promoted' };
    },

    async recallLesson(query, limit = 5) {
      const match = ftsEscape(query);
      if (match === '') return { query, returned: 0, results: [] };
      const rs = await db().execute({
        sql: `SELECT l.id, l.description, l.status, l.body, l.applied_count, f.rank
              FROM wg_lessons_fts f JOIN wg_lessons l ON l.id = f.id
              WHERE wg_lessons_fts MATCH ? AND l.status != 'discarded'
              ORDER BY f.rank LIMIT ?`,
        args: [match, limit],
      });
      const results: WedgeRecallHit[] = rs.rows.map((r) => ({
        kind: 'lesson' as const,
        id: str(r.id),
        description: str(r.description),
        status: str(r.status) as LessonStatus,
        body_preview: str(r.body).slice(0, 240),
        similarity: Math.round((1 / (1 + num(r.rank))) * 1000) / 1000,
        applied_count: num(r.applied_count),
      }));
      return { query, returned: results.length, results };
    },

    async captureFeedback(id, polarity, signalId) {
      const row = await read(id);
      const signals = row.externalSignalSources.includes(signalId)
        ? row.externalSignalSources
        : [...row.externalSignalSources, signalId]; // idempotent set-add → satisfies the external-signal gate
      await upsert({
        ...row,
        thumbsUpCount: row.thumbsUpCount + (polarity === 'up' ? 1 : 0),
        thumbsDownCount: row.thumbsDownCount + (polarity === 'down' ? 1 : 0),
        externalSignalSources: signals,
        updatedAt: now(),
      });
    },

    async recordApplied(id, sessionId) {
      const row = await read(id);
      const sessions =
        sessionId === undefined || row.appliedSessionIds.includes(sessionId)
          ? row.appliedSessionIds
          : [...row.appliedSessionIds, sessionId].slice(-MAX_APPLIED_SESSION_IDS);
      await upsert({
        ...row,
        appliedCount: row.appliedCount + 1,
        lastAppliedAt: now(),
        appliedSessionIds: sessions,
        updatedAt: now(),
      });
    },

    async rebuild(records) {
      const c = db();
      await c.execute(`DELETE FROM wg_lessons`);
      await c.execute(`DELETE FROM wg_lessons_fts`);
      for (const r of records) await dbInsert(c, r);
      return { indexed: records.length };
    },
  };
}
