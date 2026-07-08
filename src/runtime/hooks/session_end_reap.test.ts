/**
 * WGL.4 (wg-141e0ffd9955) — the SESSION-END reaper seam. Proves the injectable + fail-open (caller-owned)
 * contract: the default binds `reapOrphans`, an injected spy is used verbatim, and a throwing reap PROPAGATES
 * to the caller's try/catch (session-end owns fail-open — this seam never swallows).
 */
import { describe, expect, it, vi } from 'vitest';

import type { WorkGraphFacade } from '../../workgraph/types.js';

import { reapOrphansIfAllowed } from './session_end_reap.js';

describe('reapOrphansIfAllowed (WGL.4 session-end seam)', () => {
  it('delegates to the injected reap spy and returns its result', async () => {
    const reap = vi.fn().mockResolvedValue(['wg-1', 'wg-2']);
    const out = await reapOrphansIfAllowed({} as unknown as WorkGraphFacade, '/cwd', { reap });
    expect(reap).toHaveBeenCalledOnce();
    expect(out).toEqual(['wg-1', 'wg-2']);
  });

  it('a throwing reap PROPAGATES (fail-open is the caller try/catch, not this seam)', async () => {
    const reap = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(
      reapOrphansIfAllowed({} as unknown as WorkGraphFacade, '/cwd', { reap }),
    ).rejects.toThrow('boom');
  });

  it('defaults to the shipped reapOrphans when no dep is injected (empty board → [])', async () => {
    const wg = {
      listIssues: () => Promise.resolve([]),
      listEdges: () => Promise.resolve([]),
      archiveIssue: () => Promise.resolve(),
    } as unknown as WorkGraphFacade;
    expect(await reapOrphansIfAllowed(wg, '/cwd')).toEqual([]);
  });
});
