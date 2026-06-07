/**
 * libSQL-backed work-graph store (T-WORKGRAPH-CORE, rewrite Phase 1 slice 1c) — the beads model:
 * `wg_issues` + `wg_edges` (blocks / parent-child / discovered-from / related) + `wg_events`
 * (append-only). The headline `listReady` derives blocked-ness purely from `blocks` edges (an
 * open issue with an un-closed blocker is excluded) — blocked is never stored.
 *
 * Lives in the SAME store DB as the lessons (the design's "ONE libSQL file, 3 layers"); `wg_`
 * table prefix avoids any clash. Mirrors the libsql_store access pattern (createClient + execute)
 * and the audit_log hash primitive (createHash sha256 slice) for collision-resistant ids.
 *
 * Imports from: node:crypto, @libsql/client, ./types.js.
 */
import { createHash } from 'node:crypto';

import { type Client, type Row, createClient } from '@libsql/client';

import type { EdgeType, Issue, IssueStatus, WgEvent, WorkGraphStore } from './types.js';

const EDGE_TYPES = new Set<EdgeType>(['blocks', 'parent-child', 'discovered-from', 'related']);

const newId = (title: string): string =>
  'wg-' +
  createHash('sha256')
    .update(`${title}\n${String(Date.now())}\n${String(Math.random())}`)
    .digest('hex')
    .slice(0, 12);

const str = (r: Row, k: string): string => (typeof r[k] === 'string' ? r[k] : '');
const toStatus = (s: string): IssueStatus => (s === 'in_progress' || s === 'closed' ? s : 'open');
const rowToIssue = (r: Row): Issue => ({
  id: str(r, 'id'),
  title: str(r, 'title'),
  body: str(r, 'body'),
  status: toStatus(str(r, 'status')),
  createdAt: str(r, 'created_at'),
  updatedAt: str(r, 'updated_at'),
});

export function workGraphStore(opts: { dbUrl: string }): WorkGraphStore {
  let client: Client | null = null;
  const db = (): Client => {
    if (!client) throw new Error('workgraph: not initialized');
    return client;
  };
  const event = (issueId: string, kind: string, data: Record<string, unknown>): Promise<unknown> =>
    db().execute({
      sql: 'INSERT INTO wg_events (issue_id, ts, kind, data) VALUES (?, ?, ?, ?)',
      args: [issueId, new Date().toISOString(), kind, JSON.stringify(data)],
    });
  const getIssue = async (id: string): Promise<Issue | null> => {
    const rs = await db().execute({ sql: 'SELECT * FROM wg_issues WHERE id = ?', args: [id] });
    const row = rs.rows[0];
    return row ? rowToIssue(row) : null;
  };

  return {
    async init() {
      client = createClient({ url: opts.dbUrl });
      await client.execute(`CREATE TABLE IF NOT EXISTS wg_issues (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`);
      await client.execute(`CREATE TABLE IF NOT EXISTS wg_edges (
        from_id TEXT NOT NULL, to_id TEXT NOT NULL, type TEXT NOT NULL,
        PRIMARY KEY (from_id, to_id, type));`);
      await client.execute(`CREATE TABLE IF NOT EXISTS wg_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, issue_id TEXT NOT NULL, ts TEXT NOT NULL,
        kind TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}');`);
    },

    getIssue,

    async createIssue({ title, body = '' }) {
      const now = new Date().toISOString();
      const issue: Issue = {
        id: newId(title),
        title,
        body,
        status: 'open',
        createdAt: now,
        updatedAt: now,
      };
      await db().execute({
        sql: 'INSERT INTO wg_issues (id, title, body, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        args: [issue.id, title, body, 'open', now, now],
      });
      await event(issue.id, 'created', { title });
      return issue;
    },

    async listIssues(filter) {
      const rs =
        filter?.status !== undefined
          ? await db().execute({
              sql: 'SELECT * FROM wg_issues WHERE status = ? ORDER BY created_at',
              args: [filter.status],
            })
          : await db().execute('SELECT * FROM wg_issues ORDER BY created_at');
      return rs.rows.map(rowToIssue);
    },

    async updateIssue(id, patch) {
      const cur = await getIssue(id);
      if (cur === null) throw new Error(`workgraph: no issue ${id}`);
      const next: Issue = {
        ...cur,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.body !== undefined ? { body: patch.body } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        updatedAt: new Date().toISOString(),
      };
      await db().execute({
        sql: 'UPDATE wg_issues SET title=?, body=?, status=?, updated_at=? WHERE id=?',
        args: [next.title, next.body, next.status, next.updatedAt, id],
      });
      if (patch.status !== undefined && patch.status !== cur.status) {
        await event(id, 'status_changed', { from: cur.status, to: patch.status });
      } else {
        await event(id, 'updated', {});
      }
      return next;
    },

    async addEdge(fromId, toId, type) {
      if (!EDGE_TYPES.has(type)) throw new Error(`workgraph: bad edge type ${type}`);
      if (fromId === toId) throw new Error('workgraph: self-edge rejected');
      if ((await getIssue(fromId)) === null || (await getIssue(toId)) === null) {
        throw new Error('workgraph: edge endpoint missing');
      }
      await db().execute({
        sql: 'INSERT OR IGNORE INTO wg_edges (from_id, to_id, type) VALUES (?, ?, ?)',
        args: [fromId, toId, type],
      });
    },

    async listReady() {
      const rs = await db().execute(`SELECT * FROM wg_issues WHERE status = 'open' AND id NOT IN (
        SELECT e.to_id FROM wg_edges e JOIN wg_issues x ON x.id = e.from_id
        WHERE e.type = 'blocks' AND x.status != 'closed') ORDER BY created_at`);
      return rs.rows.map(rowToIssue);
    },

    async listEvents(issueId) {
      const rs = await db().execute({
        sql: 'SELECT id, issue_id, ts, kind, data FROM wg_events WHERE issue_id = ? ORDER BY id',
        args: [issueId],
      });
      return rs.rows.map((r): WgEvent => {
        let data: Record<string, unknown> = {};
        try {
          data = JSON.parse(str(r, 'data')) as Record<string, unknown>;
        } catch {
          data = {};
        }
        return {
          id: typeof r.id === 'number' ? r.id : Number(r.id ?? 0),
          issueId: str(r, 'issue_id'),
          ts: str(r, 'ts'),
          kind: str(r, 'kind'),
          data,
        };
      });
    },
  };
}
