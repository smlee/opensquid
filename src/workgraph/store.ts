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

import type {
  ClaimAudience,
  EdgeType,
  Issue,
  IssueStatus,
  WgOp,
  WorkGraphFacade,
  WorkGraphStore,
} from './types.js';

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
const optStr = (r: Row, k: string): string | undefined => {
  const v = r[k];
  return typeof v === 'string' && v !== '' ? v : undefined;
};
const parseAudience = (r: Row): ClaimAudience | undefined => {
  const raw = optStr(r, 'claim_audience');
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as ClaimAudience;
  } catch {
    return undefined;
  }
};
const rowToIssue = (r: Row): Issue => {
  const claimToken = optStr(r, 'claim_token');
  const claimAudience = parseAudience(r);
  const claimExpiresAt = optStr(r, 'claim_expires_at');
  const wedgeReason = optStr(r, 'wedge_reason');
  return {
    id: str(r, 'id'),
    title: str(r, 'title'),
    body: str(r, 'body'),
    status: toStatus(str(r, 'status')),
    createdAt: str(r, 'created_at'),
    updatedAt: str(r, 'updated_at'),
    ...(claimToken === undefined ? {} : { claimToken }),
    ...(claimAudience === undefined ? {} : { claimAudience }),
    ...(claimExpiresAt === undefined ? {} : { claimExpiresAt }),
    ...(wedgeReason === undefined ? {} : { wedgeReason }),
  };
};

async function createSchema(client: Client): Promise<void> {
  // T-WORKGRAPH-PROJECT-SCOPE: `project` is a plain column (NOT in any PK — ids are globally unique), DEFAULT
  // 'legacy-global' so pre-existing rows backfill via the idempotent ADD COLUMN below + the rebuild replay.
  await client.execute(`CREATE TABLE IF NOT EXISTS wg_ops (
    id TEXT PRIMARY KEY, issue_id TEXT NOT NULL, lamport INTEGER NOT NULL,
    type TEXT NOT NULL, payload TEXT NOT NULL, ts TEXT NOT NULL,
    project TEXT NOT NULL DEFAULT 'legacy-global');`);
  await client.execute(`CREATE TABLE IF NOT EXISTS wg_issues (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    lww INTEGER NOT NULL DEFAULT 0,
    claim_token TEXT, claim_audience TEXT, claim_expires_at TEXT, wedge_reason TEXT,
    project TEXT NOT NULL DEFAULT 'legacy-global');`);
  await client.execute(`CREATE TABLE IF NOT EXISTS wg_edges (
    edge_key TEXT PRIMARY KEY, from_id TEXT NOT NULL, to_id TEXT NOT NULL, type TEXT NOT NULL,
    project TEXT NOT NULL DEFAULT 'legacy-global');`);
  // GR.1/GR.3 + project — additive columns for a pre-existing schema (idempotent; already-migrated throws).
  for (const ddl of [
    `ALTER TABLE wg_issues ADD COLUMN claim_token TEXT`,
    `ALTER TABLE wg_issues ADD COLUMN claim_audience TEXT`,
    `ALTER TABLE wg_issues ADD COLUMN claim_expires_at TEXT`,
    `ALTER TABLE wg_issues ADD COLUMN wedge_reason TEXT`,
    `ALTER TABLE wg_ops ADD COLUMN project TEXT NOT NULL DEFAULT 'legacy-global'`,
    `ALTER TABLE wg_issues ADD COLUMN project TEXT NOT NULL DEFAULT 'legacy-global'`,
    `ALTER TABLE wg_edges ADD COLUMN project TEXT NOT NULL DEFAULT 'legacy-global'`,
  ]) {
    try {
      await client.execute(ddl);
    } catch {
      /* column already exists */
    }
  }
  await client.execute(`DROP TABLE IF EXISTS wg_events;`); // clean cutover from the 1c state-primary store
}

export function workGraphStore(opts: { dbUrl: string; sourceDir?: string }): WorkGraphStore {
  let client: Client | null = null;
  let hwm = 0; // Lamport high-water mark
  const db = (): Client => {
    if (!client) throw new Error('workgraph: not initialized');
    return client;
  };

  // project-scoped: reads filter by it. (id is globally unique, so the filter is also an isolation guard.)
  const getIssue = async (project: string, id: string): Promise<Issue | null> => {
    const rs = await db().execute({
      sql: 'SELECT * FROM wg_issues WHERE id = ? AND project = ?',
      args: [id, project],
    });
    const row = rs.rows[0];
    return row ? rowToIssue(row) : null;
  };

  // Append one op: file-first (git truth) when sourceDir set, then wg_ops, then fold the projection. The
  // single `hwm` stays GLOBAL (one clock) → distinct lamports → unique op-ids; `project` is stamped on the op.
  async function appendOp(
    project: string,
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
      project,
    };
    if (opts.sourceDir !== undefined) {
      await atomicWriteFile(
        join(opts.sourceDir, `${safeRecordId(op.id)}.json`),
        JSON.stringify(op, null, 2),
      );
    }
    await db().execute({
      sql: 'INSERT INTO wg_ops (id, issue_id, lamport, type, payload, ts, project) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: [op.id, op.issueId, op.lamport, op.type, JSON.stringify(op.payload), ts, op.project],
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

    async createIssue(project, { title, body = '' }) {
      const id = newIssueId(title);
      await appendOp(project, id, 'issue_created', { title, body });
      const issue = await getIssue(project, id);
      if (issue === null) throw new Error('workgraph: createIssue failed to project');
      return issue;
    },

    async listIssues(project, filter) {
      const rs =
        filter?.status !== undefined
          ? await db().execute({
              sql: 'SELECT * FROM wg_issues WHERE project = ? AND status = ? ORDER BY created_at',
              args: [project, filter.status],
            })
          : await db().execute({
              sql: 'SELECT * FROM wg_issues WHERE project = ? ORDER BY created_at',
              args: [project],
            });
      return rs.rows.map(rowToIssue);
    },

    async updateIssue(project, id, patch) {
      const cur = await getIssue(project, id);
      if (cur === null) throw new Error(`workgraph: no issue ${id}`);
      const payload: Record<string, unknown> = {};
      if (patch.title !== undefined) payload.title = patch.title;
      if (patch.body !== undefined) payload.body = patch.body;
      if (patch.status !== undefined) payload.status = patch.status;
      await appendOp(project, id, 'issue_set', payload);
      const next = await getIssue(project, id);
      if (next === null) throw new Error('workgraph: updateIssue lost the issue');
      return next;
    },

    async addEdge(project, fromId, toId, type) {
      if (!EDGE_TYPES.has(type)) throw new Error(`workgraph: bad edge type ${type}`);
      if (fromId === toId) throw new Error('workgraph: self-edge rejected');
      if ((await getIssue(project, fromId)) === null || (await getIssue(project, toId)) === null) {
        throw new Error('workgraph: edge endpoint missing');
      }
      await appendOp(project, fromId, 'dep_added', { from: fromId, to: toId, type });
    },

    async listReady(project) {
      // Open, unblocked, AND not live-claimed. A claim with claim_expires_at <= now is treated as
      // unclaimed (query-time expiry — no reaper). ISO-8601 UTC sorts lexically == chronologically. The
      // outer query is project-scoped; the NOT-IN subquery stays unscoped — edge endpoints are same-project
      // (addEdge's getIssue check) and ids are globally unique, so it's correct without a filter.
      const now = new Date().toISOString();
      const rs = await db().execute({
        sql: `SELECT * FROM wg_issues WHERE project = ? AND status = 'open'
          AND (claim_token IS NULL OR claim_expires_at <= ?)
          AND wedge_reason IS NULL
          AND id NOT IN (
            SELECT e.to_id FROM wg_edges e JOIN wg_issues x ON x.id = e.from_id
            WHERE e.type = 'blocks' AND x.status != 'closed') ORDER BY created_at`,
        args: [project, now],
      });
      return rs.rows.map(rowToIssue);
    },

    async wedgeMark(project, id, reason: string) {
      if ((await getIssue(project, id)) === null) throw new Error(`workgraph: no issue ${id}`);
      await appendOp(project, id, 'wedge_marked', { reason });
    },

    async clearWedge(project, id) {
      if ((await getIssue(project, id)) === null) throw new Error(`workgraph: no issue ${id}`);
      await appendOp(project, id, 'wedge_cleared', {});
    },

    async releaseClaim(project, id) {
      if ((await getIssue(project, id)) === null) throw new Error(`workgraph: no issue ${id}`);
      await appendOp(project, id, 'claim_released', {});
    },

    async claimIssue(project, id, audience: ClaimAudience, ttlSec) {
      if ((await getIssue(project, id)) === null) throw new Error(`workgraph: no issue ${id}`);
      const expiresAt = new Date(Date.now() + ttlSec * 1000).toISOString();
      // Unique per attempt → robust read-back (no two claims collide even at the same ms/expiry).
      const claimToken =
        'clm-' +
        createHash('sha256')
          .update(`${id}\n${String(Date.now())}\n${String(Math.random())}`)
          .digest('hex')
          .slice(0, 16);
      await appendOp(project, id, 'claim_acquired', { claimToken, audience, expiresAt });
      // applyOp ran the conditional CAS; we won iff OUR token is the one that landed.
      const cur = await getIssue(project, id);
      return { won: cur?.claimToken === claimToken, expiresAt };
    },

    async listEvents(project, issueId) {
      const rs = await db().execute({
        sql: 'SELECT id, issue_id, lamport, type, payload, project FROM wg_ops WHERE issue_id = ? AND project = ? ORDER BY lamport, id',
        args: [issueId, project],
      });
      return rs.rows.map(
        (r): WgOp => ({
          id: str(r, 'id'),
          issueId: str(r, 'issue_id'),
          lamport: num(r.lamport),
          type: str(r, 'type') as WgOp['type'],
          payload: JSON.parse(str(r, 'payload') || '{}') as Record<string, unknown>,
          project: str(r, 'project'),
        }),
      );
    },
  };
}

/**
 * T-WORKGRAPH-PROJECT-SCOPE — bind a `project` to the single shared store, yielding the per-project
 * {@link WorkGraphFacade} the MCP handlers call (same signatures, `project` injected). `init` is omitted —
 * the base store is initialized once by the caller (`getWorkGraph`).
 */
export function bindProject(base: WorkGraphStore, project: string): WorkGraphFacade {
  return {
    createIssue: (input) => base.createIssue(project, input),
    getIssue: (id) => base.getIssue(project, id),
    listIssues: (filter) => base.listIssues(project, filter),
    updateIssue: (id, patch) => base.updateIssue(project, id, patch),
    addEdge: (fromId, toId, type) => base.addEdge(project, fromId, toId, type),
    listReady: () => base.listReady(project),
    claimIssue: (id, audience, ttlSec) => base.claimIssue(project, id, audience, ttlSec),
    wedgeMark: (id, reason) => base.wedgeMark(project, id, reason),
    clearWedge: (id) => base.clearWedge(project, id),
    releaseClaim: (id) => base.releaseClaim(project, id),
    listEvents: (issueId) => base.listEvents(project, issueId),
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
    const op = JSON.parse(await readFile(join(opts.sourceDir, f), 'utf8')) as WgOp;
    // Legacy op-files predate `project` (T-WORKGRAPH-PROJECT-SCOPE): default a missing one to 'legacy-global'
    // so the replay folds them into the global bucket (mirrors the schema DEFAULT + the resolution degrade).
    if (typeof op.project !== 'string' || op.project === '') op.project = 'legacy-global';
    ops.push(op);
  }
  ops.sort((a, b) => a.lamport - b.lamport || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  for (const op of ops) {
    await client.execute({
      sql: 'INSERT OR IGNORE INTO wg_ops (id, issue_id, lamport, type, payload, ts, project) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: [
        op.id,
        op.issueId,
        op.lamport,
        op.type,
        JSON.stringify(op.payload),
        (op.payload as { ts?: string }).ts ?? '',
        op.project,
      ],
    });
    await applyOp(client, op);
  }
  client.close();
  return ops.length;
}
