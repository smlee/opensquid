/**
 * Derive the active scope of a worksheet from its projection (T-scope-worksheet) — pure.
 * The active scope is the first entry of `order` whose projected work is incomplete; `done` when all
 * are complete. No persisted cursor (single-writable-home): position is recomputed from the projection.
 *
 * Imports from: ../../packs/schemas/worksheet.js, ./projection.js (type only).
 */
import type { Worksheet } from '../../packs/schemas/worksheet.js';
import type { ScopeProjection } from './projection.js';

export interface ActiveScope {
  i: number;
  n: number;
  scope?: Worksheet['scopes'][number] | undefined;
  done: boolean;
}

export function deriveActiveScope(ws: Worksheet, proj: ScopeProjection[]): ActiveScope {
  const n = ws.order.length;
  const i = ws.order.findIndex((id) => proj.find((p) => p.id === id)?.complete !== true);
  if (i === -1) return { i: n, n, done: true };
  const scope = ws.scopes.find((s) => s.id === ws.order[i]);
  return { i, n, scope, done: false };
}
