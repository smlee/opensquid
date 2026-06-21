/** T-scope-worksheet — deriveActiveScope: first-incomplete-in-order, done when all complete. */
import { describe, expect, it } from 'vitest';

import type { Worksheet } from '../../packs/schemas/worksheet.js';
import { deriveActiveScope } from './active_scope.js';
import type { ScopeProjection } from './projection.js';

const ws: Worksheet = {
  mode: 'batch',
  scopes: [
    { id: 'a', issue: 'wg-a', summary: 'sa' },
    { id: 'b', issue: 'wg-b', summary: 'sb' },
    { id: 'c', issue: 'wg-c', summary: 'sc' },
  ],
  order: ['a', 'b', 'c'],
};
const proj = (done: string[]): ScopeProjection[] =>
  ws.order.map((id) => ({ id, complete: done.includes(id), commits: [] }));

describe('deriveActiveScope', () => {
  it('none complete → active = first in order', () => {
    const a = deriveActiveScope(ws, proj([]));
    expect(a).toMatchObject({ i: 0, n: 3, done: false });
    expect(a.scope?.id).toBe('a');
  });

  it('first complete → active = second', () => {
    const a = deriveActiveScope(ws, proj(['a']));
    expect(a.i).toBe(1);
    expect(a.scope?.id).toBe('b');
  });

  it('out-of-order completion still walks `order` (b done, a not) → active = a', () => {
    const a = deriveActiveScope(ws, proj(['b']));
    expect(a.scope?.id).toBe('a');
  });

  it('all complete → done, no active scope', () => {
    const a = deriveActiveScope(ws, proj(['a', 'b', 'c']));
    expect(a).toMatchObject({ i: 3, n: 3, done: true });
    expect(a.scope).toBeUndefined();
  });
});
