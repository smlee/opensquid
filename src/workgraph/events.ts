/**
 * Event-sourced work-graph op-log (T-WORKGRAPH-EVENTSOURCED slice 1d). Ops are the SOURCE OF
 * TRUTH; `wg_issues`/`wg_edges` are projections folded from them. Grounded in prior-art research:
 * git-bug's op-log + Lamport ordering; beads' deterministic content-derived edge ids (#4259).
 *
 * - `makeOpId` content-addresses an op over a CANONICAL (key-sorted) payload, so the id is
 *   independent of object key insertion order; lamport keeps distinct emits distinct.
 * - `edgeKey` is the deterministic edge identity with a unit-separator so ("ab","c") and
 *   ("a","bc") never collide (`type` excluded — a re-typed edge is an update).
 * - `applyOp` is the deterministic reducer: fold ONE op into the projection. Effectful on the DB
 *   but deterministic given op order. Single-valued issue fields use LWW by lamport (`wg_issues.lww`
 *   stores the lamport of the last writer); edges use idempotent upsert/delete by `edgeKey`.
 *
 * Imports from: node:crypto, @libsql/client, ./types.js.
 * Imported by: src/workgraph/store.ts.
 */
import { createHash } from 'node:crypto';

import type { Client } from '@libsql/client';

import type { WgOp } from './types.js';

const UNIT_SEP = ''; // ASCII unit separator — cannot appear in ids

/** Canonical (key-sorted) JSON so content-addressing is independent of key insertion order. */
function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const obj = v as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(',')}}`;
}

/** Deterministic edge identity (beads #4259); unit-separated; `type` intentionally excluded. */
export const edgeKey = (fromId: string, toId: string): string =>
  createHash('sha256').update(`${fromId}${UNIT_SEP}${toId}`).digest('hex').slice(0, 16);

/** Content-addressed op id over a canonical payload; lamport keeps distinct emits distinct. */
export const makeOpId = (type: string, payload: unknown, lamport: number): string =>
  'op-' +
  createHash('sha256')
    .update(`${type}\n${String(lamport)}\n${canonicalJson(payload)}`)
    .digest('hex')
    .slice(0, 16);

const s = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * Fold one op into the `wg_issues`/`wg_edges` projection. Deterministic given op order; safe to
 * replay (idempotent for edges; LWW for issue fields via `wg_issues.lww`).
 */
export async function applyOp(client: Client, op: WgOp): Promise<void> {
  const p = op.payload;
  switch (op.type) {
    case 'issue_created':
      // created_at/updated_at = ISO ts (display); lww = lamport (the LWW stamp for issue_set).
      await client.execute({
        sql: `INSERT OR IGNORE INTO wg_issues (id, title, body, status, created_at, updated_at, lww)
              VALUES (?, ?, ?, 'open', ?, ?, ?)`,
        args: [op.issueId, s(p.title), s(p.body), s(p.ts), s(p.ts), op.lamport],
      });
      return;
    case 'issue_set':
      // LWW by lamport: a stale op (lower lww) is a no-op. updated_at carries the ISO ts.
      await client.execute({
        sql: `UPDATE wg_issues
              SET title = COALESCE(?, title), body = COALESCE(?, body),
                  status = COALESCE(?, status), updated_at = ?, lww = ?
              WHERE id = ? AND lww <= ?`,
        args: [
          p.title === undefined ? null : s(p.title),
          p.body === undefined ? null : s(p.body),
          p.status === undefined ? null : s(p.status),
          s(p.ts),
          op.lamport,
          op.issueId,
          op.lamport,
        ],
      });
      return;
    case 'dep_added':
      // type is excluded from edge identity → a re-typed (from,to) edge UPDATES its type
      // (last writer in replay order wins), so the upsert, not INSERT OR IGNORE.
      await client.execute({
        sql: `INSERT INTO wg_edges (edge_key, from_id, to_id, type) VALUES (?, ?, ?, ?)
              ON CONFLICT(edge_key) DO UPDATE SET type = excluded.type`,
        args: [edgeKey(s(p.from), s(p.to)), s(p.from), s(p.to), s(p.type)],
      });
      return;
    case 'dep_removed':
      await client.execute({
        sql: `DELETE FROM wg_edges WHERE edge_key = ?`,
        args: [edgeKey(s(p.from), s(p.to))],
      });
      return;
  }
}
