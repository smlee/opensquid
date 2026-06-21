/** T-scope-worksheet — renderWorksheet: ✅/▶️/⬜ marks, completion count, active footer. */
import { describe, expect, it } from 'vitest';

import type { Worksheet } from '../../packs/schemas/worksheet.js';
import type { ScopeProjection } from './projection.js';
import { renderWorksheet } from './render.js';

const ws: Worksheet = {
  mode: 'batch',
  scopes: [
    { id: 'a', issue: 'wg-a', summary: 'sa' },
    { id: 'b', issue: 'wg-b', summary: 'sb' },
  ],
  order: ['a', 'b'],
};

describe('renderWorksheet', () => {
  it('marks complete ✅, active ▶️, count + active footer', () => {
    const proj: ScopeProjection[] = [
      { id: 'a', issue: 'wg-a', complete: true, commits: ['abc fix a'] },
      { id: 'b', issue: 'wg-b', complete: false, commits: [] },
    ];
    const out = renderWorksheet(ws, proj);
    expect(out).toContain('1/2 complete');
    expect(out).toMatch(/✅ a/);
    expect(out).toMatch(/▶️ b/);
    expect(out).toContain('1 commit(s)');
    expect(out).toContain('_Active: b (2/2)._');
  });

  it('all complete → no active marker, all-complete footer', () => {
    const proj: ScopeProjection[] = [
      { id: 'a', issue: 'wg-a', complete: true, commits: [] },
      { id: 'b', issue: 'wg-b', complete: true, commits: [] },
    ];
    const out = renderWorksheet(ws, proj);
    expect(out).toContain('2/2 complete');
    expect(out).toContain('_All scopes complete._');
    expect(out).not.toContain('▶️');
  });
});
