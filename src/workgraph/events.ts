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
export function canonicalJson(v: unknown): string {
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

/**
 * Content-addressed op id over the `(type, lamport, actorId, canonical payload)` tuple (WGD.1). The
 * `actorId` keeps distinct device replicas distinct even when their lamports collide on a merge; `ts`
 * is NOT part of identity (it lives in the payload for display, never hashed here).
 */
export const makeOpId = (
  type: string,
  payload: unknown,
  lamport: number,
  actorId: string,
): string =>
  'op-' +
  createHash('sha256')
    .update(`${type}\n${String(lamport)}\n${actorId}\n${canonicalJson(payload)}`)
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
        sql: `INSERT OR IGNORE INTO wg_issues
              (id, title, body, status, created_at, updated_at, lww, project, created_lamport, actor_id)
              VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`,
        args: [
          op.issueId,
          s(p.title),
          s(p.body),
          s(p.ts),
          s(p.ts),
          op.lamport,
          op.project,
          op.lamport,
          op.actorId ?? 'legacy',
        ],
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
        sql: `INSERT INTO wg_edges (edge_key, from_id, to_id, type, project) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(edge_key) DO UPDATE SET type = excluded.type`,
        args: [edgeKey(s(p.from), s(p.to)), s(p.from), s(p.to), s(p.type), op.project],
      });
      return;
    case 'dep_removed':
      await client.execute({
        sql: `DELETE FROM wg_edges WHERE edge_key = ?`,
        args: [edgeKey(s(p.from), s(p.to))],
      });
      return;
    case 'issue_archived':
      // WGL.1 — soft-retire as an LWW status update, mirroring 'issue_set' (NOT the single-transition wedge
      // shape): a stale op (lower lww) is a no-op; the winner stamps lww = lamport. So a replayed out-of-order
      // archive/unarchive pair cannot resurrect an archived item. Records the optional reason.
      await client.execute({
        sql: `UPDATE wg_issues SET status = 'archived', archive_reason = ?, updated_at = ?, lww = ?
              WHERE id = ? AND lww <= ?`,
        args: [s(p.reason), s(p.ts), op.lamport, op.issueId, op.lamport],
      });
      return;
    case 'issue_unarchived':
      // WGL.1 — reverse the soft-retire back to 'open' (LWW, clearing the reason).
      await client.execute({
        sql: `UPDATE wg_issues SET status = 'open', archive_reason = NULL, updated_at = ?, lww = ?
              WHERE id = ? AND lww <= ?`,
        args: [s(p.ts), op.lamport, op.issueId, op.lamport],
      });
      return;
    case 'claim_acquired':
      // GR.1 — exactly-once CAS at the projection: the claim lands ONLY if the item is currently
      // unclaimed OR its prior claim already expired (claim_expires_at <= this op's ts). Replaying
      // in lamport order makes exactly one concurrent claim win; the loser's UPDATE matches 0 rows.
      // Expiry is read at query time (listReady) — no reaper. claim_token is the unique winner mark.
      await client.execute({
        sql: `UPDATE wg_issues
              SET claim_token = ?, claim_audience = ?, claim_expires_at = ?, updated_at = ?
              WHERE id = ? AND status = 'open'
                AND (claim_token IS NULL OR claim_expires_at <= ?)`,
        args: [
          s(p.claimToken),
          s(p.audience === undefined ? '' : JSON.stringify(p.audience)),
          s(p.expiresAt),
          s(p.ts),
          op.issueId,
          s(p.ts),
        ],
      });
      return;
    case 'wedge_marked':
      // GR.3 — record the wedge reason; listReady excludes wedge-marked items (escalate, not re-attempt).
      await client.execute({
        sql: `UPDATE wg_issues SET wedge_reason = ?, updated_at = ? WHERE id = ?`,
        args: [s(p.reason), s(p.ts), op.issueId],
      });
      return;
    case 'wedge_cleared':
      // GR.4 — un-wedge (human-override resolution): the item re-enters listReady for another lap.
      await client.execute({
        sql: `UPDATE wg_issues SET wedge_reason = NULL, updated_at = ? WHERE id = ?`,
        args: [s(p.ts), op.issueId],
      });
      return;
    case 'claim_released':
      // wg-8e1104f1934b — drop a live claim so an un-wedged item is IMMEDIATELY re-claimable
      // (resolveParked's snappy-retry intent), not stuck until the TTL expires.
      await client.execute({
        sql: `UPDATE wg_issues
              SET claim_token = NULL, claim_audience = NULL, claim_expires_at = NULL, updated_at = ?
              WHERE id = ?`,
        args: [s(p.ts), op.issueId],
      });
      return;
  }
}
