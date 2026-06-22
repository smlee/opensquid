/**
 * KANBAN.1 — a kanban overlay DB that MAPS the work-graph (does NOT replace it).
 *
 * User direction (2026-06-21): "use the db to MAP the work-graphs, NOT replace it." The work-graph
 * (`src/workgraph/`, the deliberate event-sourced op-log — [[project-workgraph-eventsourced-decision]]) is
 * UNTOUCHED. This thin overlay stores ONLY board membership + an explicit `position` (the deterministic order
 * the work-graph lacks), and DERIVES kanban lanes LIVE from the work-graph's read surface — so it duplicates
 * no work-graph state/semantics (`listReady` already encapsulates blocked-by-edge + claim-expiry).
 *
 * Spec: loop/docs/tasks/T-kanban-mapping-store.md.
 */
import { createClient, type Client } from '@libsql/client';

import type { Issue } from '../workgraph/types.js';

/** The exact work-graph read surface the overlay needs (a subset of `WorkGraphStore` — `types.ts:63,70`).
 *  INJECTED, so the overlay never imports `workgraph/store` internals (additive + decoupled). */
export interface WorkGraphReader {
  listIssues(): Promise<Issue[]>;
  listReady(): Promise<Issue[]>;
}

export type Lane = 'backlog' | 'active' | 'blocked' | 'wedged' | 'done';

export interface Card {
  cardId: string;
  position: number;
  lane: Lane;
  issue: Issue;
}

/**
 * FIRST-MATCH lane precedence (pre-research §0). `listReady` already excludes blocked + live-claimed +
 * wedged + non-open (`types.ts:4-5,31-35,69-70`), so the overlay re-derives NONE of that — it reads `status`
 * + `wedgeReason` + ready-membership only. `wedged` precedes `active` because a `wedgeMark` leaves `status`
 * unchanged (`types.ts:37,85`), so an `in_progress` issue can also carry a wedge. `wedgeReason` is
 * undefined-or-string (never null — `store.ts:64` conditional spread), so `!== undefined` is exact.
 */
export function deriveLane(issue: Issue, readyIds: ReadonlySet<string>): Lane {
  if (issue.status === 'closed') return 'done';
  if (issue.wedgeReason !== undefined) return 'wedged';
  if (issue.status === 'in_progress') return 'active';
  if (readyIds.has(issue.id)) return 'backlog'; // open + ready (unblocked, unclaimed)
  return 'blocked'; // open + absent from listReady ⇒ blocked-by-edge OR live-claimed (work-graph-owned)
}

export interface KanbanMapStore {
  init(): Promise<void>;
  createBoard(project: string, name: string, goal: string): Promise<void>;
  place(project: string, board: string, cardId: string): Promise<void>;
  remove(project: string, board: string, cardId: string): Promise<void>;
  board(
    project: string,
    name: string,
    reader: WorkGraphReader,
  ): Promise<{ goal: string; lanes: Record<Lane, Card[]> }>;
}

/** libSQL row values are `string | number | bigint | ArrayBuffer | null`; a TEXT column reads back as a
 *  string — coerce defensively (mirrors `workgraph/store.ts`'s `str` helper). */
const asStr = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * KANBAN.4 data-PRESERVING migration. On a FRESH db the scoped `CREATE TABLE IF NOT EXISTS` in `init()` already
 * made the tables → `hasProject` true → no-op. On an OLD-schema db the `CREATE IF NOT EXISTS` was a no-op (the
 * table exists BY NAME with the old columns), so `PRAGMA` reads the legacy columns, detects no `project`, and
 * rename-aside → recreate-scoped → copy → drop, backfilling 'legacy-global' (a project-unknown bucket).
 * Board curation (removes/subsets/positions) is NOT regenerable, so rows MUST be preserved; SQLite cannot add a
 * column to a PK in place, so the table-copy is required. Idempotent via the `hasProject` guard.
 */
async function migrateAddProject(c: Client): Promise<void> {
  const tables = [
    { name: 'kanban_boards', cols: 'name, goal, created_at', pk: 'project, name' },
    {
      name: 'kanban_cards',
      cols: 'board, card_id, position, added_at',
      pk: 'project, board, card_id',
    },
  ] as const;
  for (const t of tables) {
    const info = await c.execute(`PRAGMA table_info(${t.name})`);
    if (info.rows.some((r) => r.name === 'project')) continue; // fresh / already-scoped → no-op
    const decls = t.cols
      .split(', ')
      .map((col) => `${col} ${col === 'position' ? 'INTEGER' : 'TEXT'} NOT NULL`)
      .join(', ');
    await c.execute(`ALTER TABLE ${t.name} RENAME TO ${t.name}_legacy`);
    await c.execute(
      `CREATE TABLE ${t.name} (project TEXT NOT NULL, ${decls}, PRIMARY KEY (${t.pk}))`,
    );
    await c.execute(
      `INSERT INTO ${t.name} (project, ${t.cols}) SELECT 'legacy-global', ${t.cols} FROM ${t.name}_legacy`,
    );
    await c.execute(`DROP TABLE ${t.name}_legacy`);
  }
}

export function kanbanMapStore(dbUrl: string): KanbanMapStore {
  let client: Client | null = null;
  const db = (): Client => {
    if (!client) throw new Error('kanban: not initialized');
    return client;
  };
  const nowIso = (): string => new Date().toISOString();

  return {
    async init() {
      const c = createClient({ url: dbUrl });
      await c.execute(
        `CREATE TABLE IF NOT EXISTS kanban_boards (
           project TEXT NOT NULL, name TEXT NOT NULL, goal TEXT NOT NULL, created_at TEXT NOT NULL,
           PRIMARY KEY (project, name))`,
      );
      await c.execute(
        `CREATE TABLE IF NOT EXISTS kanban_cards (
           project TEXT NOT NULL, board TEXT NOT NULL, card_id TEXT NOT NULL, position INTEGER NOT NULL,
           added_at TEXT NOT NULL, PRIMARY KEY (project, board, card_id))`,
      );
      await migrateAddProject(c);
      client = c;
    },

    async createBoard(project, name, goal) {
      await db().execute({
        sql: 'INSERT INTO kanban_boards (project, name, goal, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(project, name) DO UPDATE SET goal = excluded.goal',
        args: [project, name, goal, nowIso()],
      });
    },

    async place(project, board, cardId) {
      // position = MAX+1 within (project, board); idempotent — a re-place is a no-op (keeps the existing position).
      const rs = await db().execute({
        sql: 'SELECT COALESCE(MAX(position), 0) AS m FROM kanban_cards WHERE project = ? AND board = ?',
        args: [project, board],
      });
      const next = Number(rs.rows[0]?.m ?? 0) + 1;
      await db().execute({
        sql: 'INSERT INTO kanban_cards (project, board, card_id, position, added_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(project, board, card_id) DO NOTHING',
        args: [project, board, cardId, next, nowIso()],
      });
    },

    async remove(project, board, cardId) {
      await db().execute({
        sql: 'DELETE FROM kanban_cards WHERE project = ? AND board = ? AND card_id = ?',
        args: [project, board, cardId],
      });
    },

    async board(project, name, reader) {
      const goalRs = await db().execute({
        sql: 'SELECT goal FROM kanban_boards WHERE project = ? AND name = ?',
        args: [project, name],
      });
      const goal = asStr(goalRs.rows[0]?.goal);
      const placed = await db().execute({
        // deterministic order: position, then card_id (PK tiebreak per project+board) — no serialization needed.
        sql: 'SELECT card_id, position FROM kanban_cards WHERE project = ? AND board = ? ORDER BY position, card_id',
        args: [project, name],
      });
      const [issues, ready] = await Promise.all([reader.listIssues(), reader.listReady()]);
      const byId = new Map(issues.map((i) => [i.id, i]));
      const readyIds = new Set(ready.map((i) => i.id));
      const lanes: Record<Lane, Card[]> = {
        backlog: [],
        active: [],
        blocked: [],
        wedged: [],
        done: [],
      };
      for (const row of placed.rows) {
        const cardId = asStr(row.card_id);
        const issue = byId.get(cardId);
        if (issue === undefined) continue; // a placed card whose work-graph issue is gone → skip (no throw)
        const position = Number(row.position);
        const lane = deriveLane(issue, readyIds);
        lanes[lane].push({ cardId, position, lane, issue });
      }
      return { goal, lanes };
    },
  };
}
