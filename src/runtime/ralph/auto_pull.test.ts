/** auto_pull / base-refresh wiring — featBranch + retired branchNameFor + reconcile via stub. */
import { describe, it, expect } from 'vitest';
import { branchNameFor, featBranchFromTitle } from './auto_pull.js';
import { reconcileBase, type BaseRefreshIo } from '../release/base_refresh.js';

describe('branchNameFor retired', () => {
  it('throws — mechanical auto/wg-<id> is gone', () => {
    expect(() => branchNameFor('wg-abc')).toThrow(/retired/);
  });
});

describe('featBranchFromTitle', () => {
  it('semantic feat/<slug>', () => {
    expect(featBranchFromTitle('Ship the fix')).toBe('feat/ship-the-fix');
  });
});

describe('reconcileBase hot-patch (preserve both on diverge)', () => {
  it('diverged tips merge; never ff-only reject', async () => {
    const log: string[] = [];
    const io: BaseRefreshIo = {
      fetch: () => Promise.resolve(),
      checkout: () => Promise.resolve(),
      revParse: (ref) => Promise.resolve(ref.includes('origin') ? 'REMOTE' : 'LOCAL'),
      isAncestor: () => Promise.resolve(false), // diverged
      merge: (ref) => (log.push(ref), Promise.resolve()),
      abortMerge: () => Promise.resolve(),
    };
    const r = await reconcileBase('/r', 'main', 'origin', io);
    expect(r.kind).toBe('merged');
    expect(log).toEqual(['origin/main']);
  });
});
