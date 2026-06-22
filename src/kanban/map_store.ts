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
  createBoard(name: string, goal: string): Promise<void>;
  place(board: string, cardId: string): Promise<void>;
  remove(board: string, cardId: string): Promise<void>;
  board(
    name: string,
    reader: WorkGraphReader,
  ): Promise<{ goal: string; lanes: Record<Lane, Card[]> }>;
}

/** libSQL row values are `string | number | bigint | ArrayBuffer | null`; a TEXT column reads back as a
 *  string — coerce defensively (mirrors `workgraph/store.ts`'s `str` helper). */
const asStr = (v: unknown): string => (typeof v === 'string' ? v : '');

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
        'CREATE TABLE IF NOT EXISTS kanban_boards (name TEXT PRIMARY KEY, goal TEXT NOT NULL, created_at TEXT NOT NULL)',
      );
      await c.execute(
        `CREATE TABLE IF NOT EXISTS kanban_cards (
           board TEXT NOT NULL, card_id TEXT NOT NULL, position INTEGER NOT NULL, added_at TEXT NOT NULL,
           PRIMARY KEY (board, card_id))`,
      );
      client = c;
    },

    async createBoard(name, goal) {
      await db().execute({
        sql: 'INSERT INTO kanban_boards (name, goal, created_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET goal = excluded.goal',
        args: [name, goal, nowIso()],
      });
    },

    async place(board, cardId) {
      // position = MAX+1 within the board; idempotent — a re-place is a no-op (keeps the existing position).
      const rs = await db().execute({
        sql: 'SELECT COALESCE(MAX(position), 0) AS m FROM kanban_cards WHERE board = ?',
        args: [board],
      });
      const next = Number(rs.rows[0]?.m ?? 0) + 1;
      await db().execute({
        sql: 'INSERT INTO kanban_cards (board, card_id, position, added_at) VALUES (?, ?, ?, ?) ON CONFLICT(board, card_id) DO NOTHING',
        args: [board, cardId, next, nowIso()],
      });
    },

    async remove(board, cardId) {
      await db().execute({
        sql: 'DELETE FROM kanban_cards WHERE board = ? AND card_id = ?',
        args: [board, cardId],
      });
    },

    async board(name, reader) {
      const goalRs = await db().execute({
        sql: 'SELECT goal FROM kanban_boards WHERE name = ?',
        args: [name],
      });
      const goal = asStr(goalRs.rows[0]?.goal);
      const placed = await db().execute({
        // deterministic order: position, then card_id (PK, unique per board) as the tiebreak — no serialization needed.
        sql: 'SELECT card_id, position FROM kanban_cards WHERE board = ? ORDER BY position, card_id',
        args: [name],
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
