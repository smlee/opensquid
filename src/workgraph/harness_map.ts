/**
 * #26 — the harness-task ↔ work-graph binding overlay.
 *
 * The harness task list (Claude Code's TaskCreate/TaskUpdate store) is AUTHORITATIVE; the work-graph is a
 * MATERIALIZED VIEW of it. This thin, project-scoped libSQL overlay is the ONLY durable state the sync needs:
 * a stable `harness_task_id → wg_issue_id` binding so a re-sync updates the SAME work-graph issue instead of
 * creating a duplicate. The work-graph store (`src/workgraph/store.ts`) is UNTOUCHED — this maps it, it does
 * not replace it (the same "map-not-replace" discipline the kanban overlay uses, `src/kanban/map_store.ts`).
 *
 * CLONED from the `kanban_cards` overlay (`map_store.ts` KANBAN.1/.4): the same `(project, <key>)` PRIMARY KEY,
 * the same `ON CONFLICT DO NOTHING` idempotent insert, and the same project-namespace scoping. `bind` is
 * MONOTONIC — the first binding wins; a re-bind of an already-bound harness id is a no-op (the DO NOTHING),
 * so a harness id can never be re-pointed at a second work-graph issue.
 *
 * Imports from: @libsql/client.
 * Imported by: src/runtime/hooks/harness_graph_sync.ts.
 */
import { createClient, type Client } from '@libsql/client';

/** libSQL TEXT columns read back as strings; coerce defensively (mirrors `map_store.ts`'s `asStr`). */
const asStr = (v: unknown): string => (typeof v === 'string' ? v : '');

export interface HarnessMapStore {
  init(): Promise<void>;
  /** Bind a harness task id to a work-graph issue id (MONOTONIC — idempotent, first binding wins). */
  bind(project: string, harnessId: string, wgId: string): Promise<void>;
  /** The work-graph issue id bound to `harnessId` in `project`, or `null` if unbound. */
  get(project: string, harnessId: string): Promise<string | null>;
}

export function harnessMapStore(dbUrl: string): HarnessMapStore {
  let client: Client | null = null;
  const db = (): Client => {
    if (!client) throw new Error('harness_map: not initialized');
    return client;
  };
  return {
    async init() {
      const c = createClient({ url: dbUrl });
      await c.execute(
        `CREATE TABLE IF NOT EXISTS harness_map (
           project TEXT NOT NULL, harness_task_id TEXT NOT NULL, wg_issue_id TEXT NOT NULL,
           bound_at TEXT NOT NULL, PRIMARY KEY (project, harness_task_id))`,
      );
      client = c;
    },

    async bind(project, harnessId, wgId) {
      // ON CONFLICT DO NOTHING (KANBAN.1 template): a re-bind of an existing (project, harness_task_id) is a
      // no-op — the binding is immutable once set, so a harness id never re-points at a second wg issue.
      await db().execute({
        sql: 'INSERT INTO harness_map (project, harness_task_id, wg_issue_id, bound_at) VALUES (?, ?, ?, ?) ON CONFLICT(project, harness_task_id) DO NOTHING',
        args: [project, harnessId, wgId, new Date().toISOString()],
      });
    },

    async get(project, harnessId) {
      const rs = await db().execute({
        sql: 'SELECT wg_issue_id FROM harness_map WHERE project = ? AND harness_task_id = ?',
        args: [project, harnessId],
      });
      const row = rs.rows[0];
      return row ? asStr(row.wg_issue_id) : null;
    },
  };
}
