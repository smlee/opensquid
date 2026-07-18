/**
 * Event-sourced libSQL work-graph store (T-WORKGRAPH-EVENTSOURCED slice 1d). The op-log `wg_ops`
 * (Lamport-ordered, content-hashed ids) is the SOURCE OF TRUTH — git-versioned as ONE FILE PER OP
 * when `sourceDir` is set. `wg_issues`/`wg_edges` are PROJECTIONS folded by `applyOp` (rebuildable,
 * never authoritative). Supersedes the 1c state-primary store via a clean cutover (drops the old
 * `wg_events`; 1c is pre-release). Grounded in prior-art research: git-bug's op-log + Lamport
 * ordering (never wall-clock), beads' deterministic content-derived edge keys (#4259).
 *
 * Imports from: node:crypto, node:fs/promises, node:path, @libsql/client,
 *   ../storage/sqlite_concurrency.js, ../storage/atomic_file.js, ./events.js, ./types.js.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { type Client, type Row, createClient } from '@libsql/client';

import { applyConcurrencyPragmas } from '../storage/sqlite_concurrency.js';
import { atomicWriteFile, safeRecordId } from '../storage/atomic_file.js';

import { applyOp, canonicalJson, makeOpId } from './events.js';

import type { ClaimAudience, EdgeType, Issue, IssueStatus, WgOp, WorkGraphStore } from './types.js';

const EDGE_TYPES = new Set<EdgeType>(['blocks', 'parent-child', 'discovered-from', 'related']);

// WGD.1 — deterministic, content-addressed issue id over `(canonical {title,body}, lamport, actorId)`.
// No Date.now/Math.random → the same create on the same replica reproduces the id (rebuild/sync replay).
const newIssueId = (
  payload: { title: string; body: string },
  lamport: number,
  actorId: string,
): string =>
  'wg-' +
  createHash('sha256')
    .update(`${canonicalJson(payload)}\n${String(lamport)}\n${actorId}`)
    .digest('hex')
    .slice(0, 12);

const str = (r: Row, k: string): string => (typeof r[k] === 'string' ? r[k] : '');
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0));
// WGL.1 — 'archived' MUST be preserved (a soft, reversible terminal state); any other unknown value still
// coerces to 'open'. Miss this and an archived row would read back as 'open' and re-enter listReady.
const toStatus = (s: string): IssueStatus =>
  s === 'in_progress' || s === 'closed' || s === 'archived' ? s : 'open';
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
  const archiveReason = optStr(r, 'archive_reason'); // WGL.1
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
    ...(archiveReason === undefined ? {} : { archiveReason }),
  };
};

async function createSchema(client: Client): Promise<void> {
  // T-WORKGRAPH-PROJECT-SCOPE: `project` is a plain column (NOT in any PK — ids are globally unique), DEFAULT
  // 'legacy-global' so pre-existing rows backfill via the idempotent ADD COLUMN below + the rebuild replay.
  await client.execute(`CREATE TABLE IF NOT EXISTS wg_ops (
    id TEXT PRIMARY KEY, issue_id TEXT NOT NULL, lamport INTEGER NOT NULL,
    type TEXT NOT NULL, payload TEXT NOT NULL, ts TEXT NOT NULL,
    project TEXT NOT NULL DEFAULT 'legacy-global', actor_id TEXT);`);
  // WGD.1 — `created_lamport`/`actor_id` are the `(lamport, actor-id)` order/identity tuple. created_lamport
  // DEFAULT 0 for an ADD COLUMN on an old DB; init()'s backfillTuple then overwrites the 0 from the issue's
  // issue_created lamport (else every legacy issue ties at 0).
  await client.execute(`CREATE TABLE IF NOT EXISTS wg_issues (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    lww INTEGER NOT NULL DEFAULT 0,
    claim_token TEXT, claim_audience TEXT, claim_expires_at TEXT, wedge_reason TEXT,
    archive_reason TEXT,
    project TEXT NOT NULL DEFAULT 'legacy-global',
    created_lamport INTEGER NOT NULL DEFAULT 0, actor_id TEXT);`);
  await client.execute(`CREATE TABLE IF NOT EXISTS wg_edges (
    edge_key TEXT PRIMARY KEY, from_id TEXT NOT NULL, to_id TEXT NOT NULL, type TEXT NOT NULL,
    project TEXT NOT NULL DEFAULT 'legacy-global');`);
  // HWS.2 — a tiny durable per-store high-water-mark for the harness↔workgraph reconcile (the outbound
  // cursor over `wg_ops.lamport`). Keyed by a `name` so a future consumer can carry its own watermark; the
  // reconcile uses name='harness'. Idempotent CREATE, same template as wg_ops.
  await client.execute(
    `CREATE TABLE IF NOT EXISTS sync_cursor (name TEXT PRIMARY KEY, lamport INTEGER NOT NULL DEFAULT 0);`,
  );
  // GR.1/GR.3 + project — additive columns for a pre-existing schema (idempotent; already-migrated throws).
  for (const ddl of [
    `ALTER TABLE wg_issues ADD COLUMN claim_token TEXT`,
    `ALTER TABLE wg_issues ADD COLUMN claim_audience TEXT`,
    `ALTER TABLE wg_issues ADD COLUMN claim_expires_at TEXT`,
    `ALTER TABLE wg_issues ADD COLUMN wedge_reason TEXT`,
    `ALTER TABLE wg_issues ADD COLUMN archive_reason TEXT`, // WGL.1 (idempotent; already-migrated throws → caught)
    `ALTER TABLE wg_ops ADD COLUMN project TEXT NOT NULL DEFAULT 'legacy-global'`,
    `ALTER TABLE wg_issues ADD COLUMN project TEXT NOT NULL DEFAULT 'legacy-global'`,
    `ALTER TABLE wg_edges ADD COLUMN project TEXT NOT NULL DEFAULT 'legacy-global'`,
    // WGD.1 — the (lamport, actor-id) tuple columns (idempotent; already-migrated throws → caught).
    `ALTER TABLE wg_issues ADD COLUMN created_lamport INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE wg_issues ADD COLUMN actor_id TEXT`,
    `ALTER TABLE wg_ops ADD COLUMN actor_id TEXT`,
  ]) {
    try {
      await client.execute(ddl);
    } catch {
      /* column already exists */
    }
  }
  await client.execute(`DROP TABLE IF EXISTS wg_events;`); // clean cutover from the 1c state-primary store
}

/**
 * WGD.1 — backfill the `(lamport, actor-id)` tuple on a pre-existing DB (idempotent). `created_lamport`
 * comes from each issue's `issue_created` lamport (so legacy issues order by real Lamport, not all tied
 * at 0); a NULL `actor_id` on either table degrades to `'legacy'`. Run from `init()` after createSchema.
 */
async function backfillTuple(c: Client): Promise<void> {
  await c.execute(
    `UPDATE wg_issues SET created_lamport =
       COALESCE((SELECT MIN(lamport) FROM wg_ops
                 WHERE wg_ops.issue_id = wg_issues.id AND type = 'issue_created'), 0)
     WHERE created_lamport = 0`,
  );
  await c.execute(`UPDATE wg_issues SET actor_id = 'legacy' WHERE actor_id IS NULL`);
  await c.execute(`UPDATE wg_ops SET actor_id = 'legacy' WHERE actor_id IS NULL`);
}

// GS-durability — the live append path allocates the Lamport clock from the DB (`MAX+1`) instead of an
// in-memory `++hwm`, so N processes sharing one workgraph.db read the same shared clock. An in-process
// mutex serializes a process's own appends (gapless, no self-collision); across processes the PK on the
// content-hashed `wg_ops.id` arbitrates a same-lamport race and the loser retries onto a fresh lamport.
// A contended writer first waits on `busy_timeout`; these bounded retries then absorb the residual
// SQLITE_BUSY / PK race.
const MAX_APPEND_RETRIES = 8;
// T-project-local-state PLS.2 — the store is PROJECT-LOCAL, so there is no per-op project key. The
// `project` column stays physically (schema DEFAULT / back-compat with legacy op-files) and every op
// stamps this ONE constant; no read ever FILTERS on it. The partition cannot reappear on the IN path.
const LOCAL_PROJECT = 'legacy-global';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const isBusy = (e: unknown): boolean =>
  errText(e).includes('SQLITE_BUSY') || errText(e).includes('database is locked');
const isDupOpId = (e: unknown): boolean =>
  errText(e).includes('SQLITE_CONSTRAINT_PRIMARYKEY') ||
  errText(e).includes('UNIQUE constraint failed: wg_ops.id');
// Exponential backoff w/ jitter, capped small — `busy_timeout` already absorbs most contention.
const backoffMs = (attempt: number): number =>
  Math.min(400, 25 * 2 ** attempt) + Math.random() * 25;

export function workGraphStore(opts: {
  dbUrl: string;
  sourceDir?: string;
  // WGD.1 — this replica's actor id (the per-HOME UUID; the live openers pass `resolveActorId()`).
  // Default 'legacy' so the existing tests need no actor wiring.
  actorId?: string;
  // F1a — the ONE close-boundary callback. Invoked (fail-open) whenever `updateIssue` TRANSITIONS an issue's
  // status to a terminal value (`closed`/`archived`). The loop openers wire it to the monitor `item_closed`
  // push, so EVERY close path — including the harness-sync reconcile close that emits nothing on its own —
  // reaches the feed from ONE place (single source of truth). Injected DI keeps the store a generic lower
  // layer: a caller that passes no callback (the MCP/read openers) simply does not emit. §7-decoupled.
  onIssueTerminal?: (id: string) => void | Promise<void>;
}): WorkGraphStore {
  let client: Client | null = null;
  const actorId = opts.actorId ?? 'legacy';
  const db = (): Client => {
    if (!client) throw new Error('workgraph: not initialized');
    return client;
  };

  // In-process write mutex: libsql permits only ONE open transaction per connection, so this instance's
  // appendOp calls must run one at a time (a promise chain IS the mutex — each waits for the prior to
  // settle). The BEGIN IMMEDIATE inside appendOp then serializes writers ACROSS processes. Together:
  // one writer per connection (this) + one writer per file (BEGIN IMMEDIATE) = no interleaved allocation.
  let writeChain: Promise<unknown> = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = writeChain.then(fn, fn);
    writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  // Project-LOCAL: the store IS the project, so reads filter on nothing (ids are globally unique anyway).
  const getIssue = async (id: string): Promise<Issue | null> => {
    const rs = await db().execute({
      sql: 'SELECT * FROM wg_issues WHERE id = ?',
      args: [id],
    });
    const row = rs.rows[0];
    return row ? rowToIssue(row) : null;
  };

  // Append one op. The `serialize` mutex keeps THIS process's appends one-at-a-time, so within a process
  // the DB-derived lamport (`MAX+1`) is gapless and never self-collides. ACROSS processes, two writers can
  // still read the same MAX; the PK on the content-hashed `wg_ops.id` is the arbiter — the loser retries,
  // re-reads MAX (now +1), and lands a distinct lamport → distinct id. `busy_timeout` + the retry absorb
  // SQLITE_BUSY. No explicit transaction: libsql serializes statements per connection, and the two-phase
  // (insert-then-project) shape matches the original store; the projection is rebuildable + idempotent.
  // `issueIdArg` may be a deriver — `createIssue`'s id is itself a function of the lamport. `ts` is excluded
  // from the op-id (identity is content-only); it lives in the stored payload + column.
  async function appendOp(
    issueIdArg: string | ((lamport: number) => string),
    type: WgOp['type'],
    payload: Record<string, unknown>,
  ): Promise<{ lamport: number; issueId: string }> {
    return serialize(async () => {
      const ts = new Date().toISOString();
      // Phase 1 — allocate a lamport from the DB and INSERT the op, retrying on the cross-process PK race
      // (two writers minting the same lamport → same id) and on SQLITE_BUSY.
      let op: WgOp | null = null;
      let lastErr: unknown;
      for (let attempt = 0; attempt <= MAX_APPEND_RETRIES; attempt++) {
        try {
          const rs = await db().execute('SELECT COALESCE(MAX(lamport), 0) + 1 AS next FROM wg_ops');
          const lamport = num(rs.rows[0]?.next);
          const issueId = typeof issueIdArg === 'function' ? issueIdArg(lamport) : issueIdArg;
          const candidate: WgOp = {
            id: makeOpId(type, payload, lamport, actorId),
            issueId,
            lamport,
            type,
            payload: { ...payload, ts },
            project: LOCAL_PROJECT,
            actorId,
          };
          await db().execute({
            sql: 'INSERT INTO wg_ops (id, issue_id, lamport, type, payload, ts, project, actor_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            args: [
              candidate.id,
              candidate.issueId,
              candidate.lamport,
              candidate.type,
              JSON.stringify(candidate.payload),
              ts,
              candidate.project,
              candidate.actorId ?? 'legacy',
            ],
          });
          op = candidate;
          break;
        } catch (e) {
          lastErr = e;
          if (attempt < MAX_APPEND_RETRIES && (isBusy(e) || isDupOpId(e))) {
            await sleep(backoffMs(attempt));
            continue;
          }
          throw e;
        }
      }
      if (op === null) {
        throw lastErr instanceof Error
          ? lastErr
          : new Error('workgraph: appendOp exhausted retries');
      }
      // The op-file (git source) is written AFTER the row is durable so a retry never orphans a file that a
      // rebuild would replay as a spurious op.
      if (opts.sourceDir !== undefined) {
        await atomicWriteFile(
          join(opts.sourceDir, `${safeRecordId(op.id)}.json`),
          JSON.stringify(op, null, 2),
        );
      }
      // Phase 2 — fold the (rebuildable, idempotent) projection, BUSY-retrying. Safe to retry: applyOp is
      // INSERT-OR-IGNORE / LWW / upsert / CAS, so re-running the same op is a no-op.
      for (let attempt = 0; attempt <= MAX_APPEND_RETRIES; attempt++) {
        try {
          await applyOp(db(), op);
          break;
        } catch (e) {
          if (attempt < MAX_APPEND_RETRIES && isBusy(e)) {
            await sleep(backoffMs(attempt));
            continue;
          }
          throw e;
        }
      }
      return { lamport: op.lamport, issueId: op.issueId };
    });
  }

  return {
    async init() {
      client = createClient({ url: opts.dbUrl });
      // Concurrency posture (WAL + busy_timeout) so a ralph lap draining workgraph.db never trips SQLITE_BUSY
      // against a concurrent lap. Awaited: in force before the first schema/backfill write.
      await applyConcurrencyPragmas(client);
      await createSchema(client);
      await backfillTuple(client); // WGD.1 — fill the (lamport, actor-id) tuple on pre-existing rows
      // No in-memory Lamport seed: `appendOp` allocates each lamport atomically from the DB (MAX+1)
      // inside its transaction, so the clock is correct across every process sharing this file.
    },

    getIssue,

    async createIssue({ title, body = '' }) {
      // The issue id is a function of the atomically-allocated lamport, so it is derived INSIDE appendOp.
      const { issueId } = await appendOp(
        (lamport) => newIssueId({ title, body }, lamport, actorId),
        'issue_created',
        { title, body },
      );
      const issue = await getIssue(issueId);
      if (issue === null) throw new Error('workgraph: createIssue failed to project');
      return issue;
    },

    async listIssues(filter) {
      const rs =
        filter?.status !== undefined
          ? await db().execute({
              sql: 'SELECT * FROM wg_issues WHERE status = ? ORDER BY created_lamport, actor_id',
              args: [filter.status],
            })
          : await db().execute({
              sql: 'SELECT * FROM wg_issues ORDER BY created_lamport, actor_id',
              args: [],
            });
      return rs.rows.map(rowToIssue);
    },

    // T2.5 — the folded edge projection, `{from,to,type}` triples ordered by `edge_key` (deterministic, the
    // content-derived key). Mirrors `listIssues`; `planAudit` reads the `blocks`+`parent-child` subset from it.
    async listEdges() {
      const rs = await db().execute({
        sql: 'SELECT from_id, to_id, type FROM wg_edges ORDER BY edge_key',
        args: [],
      });
      return rs.rows.map((r) => ({
        from: str(r, 'from_id'),
        to: str(r, 'to_id'),
        type: str(r, 'type') as EdgeType,
      }));
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
      // F1a — fire the close-boundary callback on a TRANSITION into terminal (`closed`/`archived`); skip a no-op
      // re-patch of an already-terminal status so a close pushes exactly ONE event. Fail-open: a callback fault
      // (the injected monitor emit is itself fail-open) must never break the status write that just committed.
      if (
        opts.onIssueTerminal !== undefined &&
        (patch.status === 'closed' || patch.status === 'archived') &&
        cur.status !== patch.status
      ) {
        try {
          await opts.onIssueTerminal(id);
        } catch {
          /* fail-open: the close is durable regardless of the monitor push */
        }
      }
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
      // Open, unblocked, AND not live-claimed. A claim with claim_expires_at <= now is treated as
      // unclaimed (query-time expiry — no reaper). ISO-8601 UTC sorts lexically == chronologically. The
      // store is project-LOCAL, so no project filter — every row IS this project's.
      const now = new Date().toISOString();
      // WGL.1 — the `status = 'open'` predicate already hides archived ROWS; the one non-obvious ready-filter
      // edit is the blocks sub-query below (`NOT IN ('closed','archived')`) so archiving a SUPERSEDED BLOCKER
      // unblocks its consumer (an archived blocker must no longer hold its dependent).
      const rs = await db().execute({
        sql: `SELECT * FROM wg_issues WHERE status = 'open'
          AND (claim_token IS NULL OR claim_expires_at <= ?)
          AND wedge_reason IS NULL
          AND id NOT IN (
            SELECT e.to_id FROM wg_edges e JOIN wg_issues x ON x.id = e.from_id
            WHERE e.type = 'blocks' AND x.status NOT IN ('closed','archived')) ORDER BY created_lamport, actor_id`,
        args: [now],
      });
      return rs.rows.map(rowToIssue);
    },

    async renewClaim(id, expectedToken, ttlSec) {
      if ((await getIssue(id)) === null) throw new Error(`workgraph: no issue ${id}`);
      if (expectedToken.length === 0)
        throw new Error('workgraph: expected claim token is required');
      if (!Number.isSafeInteger(ttlSec) || ttlSec < 1) {
        throw new Error('workgraph: claim ttlSec must be a positive safe integer');
      }
      const expiresAt = new Date(Date.now() + ttlSec * 1000).toISOString();
      await appendOp(id, 'claim_renewed', { expectedToken, expiresAt });
      const current = await getIssue(id);
      return {
        renewed: current?.claimToken === expectedToken && current.claimExpiresAt === expiresAt,
        expiresAt,
      };
    },

    async wedgeMark(id, reason: string) {
      if ((await getIssue(id)) === null) throw new Error(`workgraph: no issue ${id}`);
      await appendOp(id, 'wedge_marked', { reason });
    },

    async clearWedge(id) {
      if ((await getIssue(id)) === null) throw new Error(`workgraph: no issue ${id}`);
      await appendOp(id, 'wedge_cleared', {});
    },

    // WGL.1 — soft-archive to the reversible `archived` terminal state (a new op, LWW, surviving replay). The
    // row is KEPT (history-preserving); listReady excludes it. `unarchiveIssue` restores it to `open`.
    async archiveIssue(id, reason?: string) {
      if ((await getIssue(id)) === null) throw new Error(`workgraph: no issue ${id}`);
      await appendOp(id, 'issue_archived', reason === undefined ? {} : { reason });
    },

    async unarchiveIssue(id) {
      if ((await getIssue(id)) === null) throw new Error(`workgraph: no issue ${id}`);
      await appendOp(id, 'issue_unarchived', {});
    },

    async releaseClaim(id, expectedToken) {
      if ((await getIssue(id)) === null) throw new Error(`workgraph: no issue ${id}`);
      await appendOp(id, 'claim_released', expectedToken === undefined ? {} : { expectedToken });
    },

    async claimIssue(
      id,
      audience: ClaimAudience,
      ttlSec,
      isAuthorized: () => boolean = () => true,
    ) {
      if ((await getIssue(id)) === null) throw new Error(`workgraph: no issue ${id}`);
      const expiresAt = new Date(Date.now() + ttlSec * 1000).toISOString();
      if (!isAuthorized()) return { won: false, expiresAt };
      // Unique per attempt → robust read-back (no two claims collide even at the same ms/expiry).
      const claimToken =
        'clm-' +
        createHash('sha256')
          .update(`${id}\n${String(Date.now())}\n${String(Math.random())}`)
          .digest('hex')
          .slice(0, 16);
      await appendOp(id, 'claim_acquired', { claimToken, audience, expiresAt });
      // applyOp ran the conditional CAS; we won iff OUR token is the one that landed.
      const cur = await getIssue(id);
      // Re-check after the durable CAS. If authority was lost while I/O yielded, release only OUR token so the
      // item is immediately recoverable without risking a successor's newer claim.
      if (cur?.claimToken === claimToken && !isAuthorized()) {
        await appendOp(id, 'claim_released', { expectedToken: claimToken });
        return { won: false, expiresAt };
      }
      return { won: cur?.claimToken === claimToken, expiresAt };
    },

    async listEvents(issueId) {
      const rs = await db().execute({
        sql: 'SELECT id, issue_id, lamport, type, payload, project, actor_id FROM wg_ops WHERE issue_id = ? ORDER BY lamport, id',
        args: [issueId],
      });
      return rs.rows.map(
        (r): WgOp => ({
          id: str(r, 'id'),
          issueId: str(r, 'issue_id'),
          lamport: num(r.lamport),
          type: str(r, 'type') as WgOp['type'],
          payload: JSON.parse(str(r, 'payload') || '{}') as Record<string, unknown>,
          project: str(r, 'project'),
          actorId: str(r, 'actor_id') || 'legacy',
        }),
      );
    },

    // HWS.2 — the STORE-GLOBAL sibling of `listEvents`: every op with `lamport > cursorLamport`, in
    // (lamport, id) order (the id tie-break makes a same-lamport cross-process race deterministic, exactly
    // as `listEvents`). `wg_ops.lamport` is already store-global monotonic (appendOp's MAX+1), so this is a
    // WHERE-clause widen of the per-issue read — no new counter. The reconcile filters the types it cares
    // about; the store stays a general cursor (single responsibility).
    async listOpsSince(cursorLamport) {
      const rs = await db().execute({
        sql: 'SELECT id, issue_id, lamport, type, payload, project, actor_id FROM wg_ops WHERE lamport > ? ORDER BY lamport, id',
        args: [cursorLamport],
      });
      return rs.rows.map(
        (r): WgOp => ({
          id: str(r, 'id'),
          issueId: str(r, 'issue_id'),
          lamport: num(r.lamport),
          type: str(r, 'type') as WgOp['type'],
          payload: JSON.parse(str(r, 'payload') || '{}') as Record<string, unknown>,
          project: str(r, 'project'),
          actorId: str(r, 'actor_id') || 'legacy',
        }),
      );
    },

    // HWS.2 — the durable high-water-mark for the harness reconcile. A fresh store returns 0 (see-everything
    // once on first run).
    async readHighWater() {
      const rs = await db().execute({
        sql: 'SELECT lamport FROM sync_cursor WHERE name = ?',
        args: ['harness'],
      });
      return rs.rows[0] ? num(rs.rows[0].lamport) : 0;
    },

    // MONOTONIC upsert — a lower value NEVER rewinds the cursor, so two concurrent reconciles (a PreToolUse
    // tick + a loop-pass) can both advance safely and neither re-emits the other's ops.
    async advanceHighWater(lamport) {
      await db().execute({
        sql: `INSERT INTO sync_cursor (name, lamport) VALUES ('harness', ?)
              ON CONFLICT(name) DO UPDATE SET lamport = MAX(sync_cursor.lamport, excluded.lamport)`,
        args: [lamport],
      });
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
  // Concurrency posture (WAL + busy_timeout) so a rebuild never trips SQLITE_BUSY against a concurrent
  // workgraph.db writer. Awaited: in force before the first DROP/schema write.
  await applyConcurrencyPragmas(client);
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
    // WGD.1 — legacy op-files predate `actorId`; default a missing one to 'legacy' (mirrors the schema/replay
    // degrade). The stored op id is REPLAYED as-is (never recomputed), so a non-reproducible lease-op id survives.
    if (typeof op.actorId !== 'string' || op.actorId === '') op.actorId = 'legacy';
    ops.push(op);
  }
  ops.sort((a, b) => a.lamport - b.lamport || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  for (const op of ops) {
    await client.execute({
      sql: 'INSERT OR IGNORE INTO wg_ops (id, issue_id, lamport, type, payload, ts, project, actor_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      args: [
        op.id,
        op.issueId,
        op.lamport,
        op.type,
        JSON.stringify(op.payload),
        (op.payload as { ts?: string }).ts ?? '',
        op.project,
        op.actorId ?? 'legacy',
      ],
    });
    await applyOp(client, op);
  }
  client.close();
  return ops.length;
}
