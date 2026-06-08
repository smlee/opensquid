/**
 * Event-sourced libSQL work-graph store (T-WORKGRAPH-EVENTSOURCED slice 1d). The op-log `wg_ops`
 * (Lamport-ordered, content-hashed ids) is the SOURCE OF TRUTH — git-versioned as ONE FILE PER OP
 * when `sourceDir` is set. `wg_issues`/`wg_edges` are PROJECTIONS folded by `applyOp` (rebuildable,
 * never authoritative). Supersedes the 1c state-primary store via a clean cutover (drops the old
 * `wg_events`; 1c is pre-release). Grounded in prior-art research: git-bug's op-log + Lamport
 * ordering (never wall-clock), beads' deterministic content-derived edge keys (#4259).
 *
 * Imports from: node:crypto, node:fs/promises, node:path, @libsql/client,
 *   ../storage/atomic_file.js, ./events.js, ./types.js.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { type Client, type Row, createClient } from '@libsql/client';

import { atomicWriteFile, safeRecordId } from '../storage/atomic_file.js';

import { applyOp, makeOpId } from './events.js';

import type { EdgeType, Issue, IssueStatus, WgOp, WorkGraphStore } from './types.js';

const EDGE_TYPES = new Set<EdgeType>(['blocks', 'parent-child', 'discovered-from', 'related']);

const newIssueId = (title: string): string =>
  'wg-' +
  createHash('sha256')
    .update(`${title}\n${String(Date.now())}\n${String(Math.random())}`)
    .digest('hex')
    .slice(0, 12);

const str = (r: Row, k: string): string => (typeof r[k] === 'string' ? r[k] : '');
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0));
const toStatus = (s: string): IssueStatus => (s === 'in_progress' || s === 'closed' ? s : 'open');
const rowToIssue = (r: Row): Issue => ({
  id: str(r, 'id'),
  title: str(r, 'title'),
  body: str(r, 'body'),
  status: toStatus(str(r, 'status')),
  createdAt: str(r, 'created_at'),
  updatedAt: str(r, 'updated_at'),
});

async function createSchema(client: Client): Promise<void> {
  await client.execute(`CREATE TABLE IF NOT EXISTS wg_ops (
    id TEXT PRIMARY KEY, issue_id TEXT NOT NULL, lamport INTEGER NOT NULL,
    type TEXT NOT NULL, payload TEXT NOT NULL, ts TEXT NOT NULL);`);
  await client.execute(`CREATE TABLE IF NOT EXISTS wg_issues (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    lww INTEGER NOT NULL DEFAULT 0);`);
  await client.execute(`CREATE TABLE IF NOT EXISTS wg_edges (
    edge_key TEXT PRIMARY KEY, from_id TEXT NOT NULL, to_id TEXT NOT NULL, type TEXT NOT NULL);`);
  await client.execute(`DROP TABLE IF EXISTS wg_events;`); // clean cutover from the 1c state-primary store
}

export function workGraphStore(opts: { dbUrl: string; sourceDir?: string }): WorkGraphStore {
  let client: Client | null = null;
  let hwm = 0; // Lamport high-water mark
  const db = (): Client => {
    if (!client) throw new Error('workgraph: not initialized');
    return client;
  };

  const getIssue = async (id: string): Promise<Issue | null> => {
    const rs = await db().execute({ sql: 'SELECT * FROM wg_issues WHERE id = ?', args: [id] });
    const row = rs.rows[0];
    return row ? rowToIssue(row) : null;
  };

  // Append one op: file-first (git truth) when sourceDir set, then wg_ops, then fold the projection.
  async function appendOp(
    issueId: string,
    type: WgOp['type'],
    payload: Record<string, unknown>,
  ): Promise<void> {
    const lamport = ++hwm;
    const ts = new Date().toISOString();
    const fullPayload = { ...payload, ts };
    const op: WgOp = {
      id: makeOpId(type, fullPayload, lamport),
      issueId,
      lamport,
      type,
      payload: fullPayload,
    };
    if (opts.sourceDir !== undefined) {
      await atomicWriteFile(
        join(opts.sourceDir, `${safeRecordId(op.id)}.json`),
        JSON.stringify(op, null, 2),
      );
    }
    await db().execute({
      sql: 'INSERT INTO wg_ops (id, issue_id, lamport, type, payload, ts) VALUES (?, ?, ?, ?, ?, ?)',
      args: [op.id, op.issueId, op.lamport, op.type, JSON.stringify(op.payload), ts],
    });
    await applyOp(db(), op);
  }

  return {
    async init() {
      client = createClient({ url: opts.dbUrl });
      await createSchema(client);
      const rs = await client.execute('SELECT COALESCE(MAX(lamport), 0) AS hwm FROM wg_ops');
      hwm = num(rs.rows[0]?.hwm);
    },

    getIssue,

    async createIssue({ title, body = '' }) {
      const id = newIssueId(title);
      await appendOp(id, 'issue_created', { title, body });
      const issue = await getIssue(id);
      if (issue === null) throw new Error('workgraph: createIssue failed to project');
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
      const payload: Record<string, unknown> = {};
      if (patch.title !== undefined) payload.title = patch.title;
      if (patch.body !== undefined) payload.body = patch.body;
      if (patch.status !== undefined) payload.status = patch.status;
      await appendOp(id, 'issue_set', payload);
      const next = await getIssue(id);
      if (next === null) throw new Error('workgraph: updateIssue lost the issue');
      return next;
    },

    async addEdge(fromId, toId, type) {
      if (!EDGE_TYPES.has(type)) throw new Error(`workgraph: bad edge type ${type}`);
      if (fromId === toId) throw new Error('workgraph: self-edge rejected');
      if ((await getIssue(fromId)) === null || (await getIssue(toId)) === null) {
        throw new Error('workgraph: edge endpoint missing');
      }
      await appendOp(fromId, 'dep_added', { from: fromId, to: toId, type });
    },

    async listReady() {
      const rs = await db().execute(`SELECT * FROM wg_issues WHERE status = 'open' AND id NOT IN (
        SELECT e.to_id FROM wg_edges e JOIN wg_issues x ON x.id = e.from_id
        WHERE e.type = 'blocks' AND x.status != 'closed') ORDER BY created_at`);
      return rs.rows.map(rowToIssue);
    },

    async listEvents(issueId) {
      const rs = await db().execute({
        sql: 'SELECT id, issue_id, lamport, type, payload FROM wg_ops WHERE issue_id = ? ORDER BY lamport, id',
        args: [issueId],
      });
      return rs.rows.map(
        (r): WgOp => ({
          id: str(r, 'id'),
          issueId: str(r, 'issue_id'),
          lamport: num(r.lamport),
          type: str(r, 'type') as WgOp['type'],
          payload: JSON.parse(str(r, 'payload') || '{}') as Record<string, unknown>,
        }),
      );
    },
  };
}

/**
 * Rebuild the projection from the per-op git source (the files are authoritative). Drops the
 * projections + op table, replays every op file in (lamport, id) order, re-folding the projection.
 * Idempotent cold-path maintenance (e.g. after a git pull/merge). Returns the op count.
 */
export async function rebuildWorkGraph(opts: {
  dbUrl: string;
  sourceDir: string;
}): Promise<number> {
  const client = createClient({ url: opts.dbUrl });
  await client.execute('DROP TABLE IF EXISTS wg_ops');
  await client.execute('DROP TABLE IF EXISTS wg_issues');
  await client.execute('DROP TABLE IF EXISTS wg_edges');
  await createSchema(client);

  let files: string[];
  try {
    files = (await readdir(opts.sourceDir)).filter((f) => f.endsWith('.json'));
  } catch {
    client.close();
    return 0;
  }
  const ops: WgOp[] = [];
  for (const f of files) {
    ops.push(JSON.parse(await readFile(join(opts.sourceDir, f), 'utf8')) as WgOp);
  }
  ops.sort((a, b) => a.lamport - b.lamport || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  for (const op of ops) {
    await client.execute({
      sql: 'INSERT OR IGNORE INTO wg_ops (id, issue_id, lamport, type, payload, ts) VALUES (?, ?, ?, ?, ?, ?)',
      args: [
        op.id,
        op.issueId,
        op.lamport,
        op.type,
        JSON.stringify(op.payload),
        (op.payload as { ts?: string }).ts ?? '',
      ],
    });
    await applyOp(client, op);
  }
  client.close();
  return ops.length;
}
