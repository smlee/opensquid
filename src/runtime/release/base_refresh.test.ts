/** base_refresh reconcile — injected BaseRefreshIo (no real git). */
import { describe, it, expect } from 'vitest';
import {
  reconcileBase,
  featBranchFromTitle,
  type BaseRefreshIo,
  type ReconcileResult,
} from './base_refresh.js';

type Stub = BaseRefreshIo & {
  log: string[];
};

function makeIo(opts: {
  local: string;
  remote: string;
  /** remote is ancestor of local → local ahead */
  remoteAncestorOfLocal: boolean;
  /** local is ancestor of remote → origin ahead */
  localAncestorOfRemote: boolean;
  mergeThrows?: boolean;
}): Stub {
  const log: string[] = [];
  const io: BaseRefreshIo = {
    fetch: (r, ref) => (log.push(`fetch:${r}:${ref}`), Promise.resolve()),
    checkout: (ref) => (log.push(`checkout:${ref}`), Promise.resolve()),
    revParse: (ref) =>
      Promise.resolve(ref.includes('/') || ref.startsWith('origin') ? opts.remote : opts.local),
    isAncestor: async (maybe, rev) => {
      if (maybe === opts.remote && rev === opts.local) return opts.remoteAncestorOfLocal;
      if (maybe === opts.local && rev === opts.remote) return opts.localAncestorOfRemote;
      return maybe === rev;
    },
    merge: (ref) => {
      log.push(`merge:${ref}`);
      if (opts.mergeThrows) return Promise.reject(new Error('conflict'));
      return Promise.resolve();
    },
    abortMerge: () => (log.push('abort'), Promise.resolve()),
  };
  return Object.assign(io, { log });
}

describe('reconcileBase — whoever is ahead', () => {
  it('origin-ahead → fast-forward merge', async () => {
    const i = makeIo({
      local: 'L',
      remote: 'R',
      remoteAncestorOfLocal: false,
      localAncestorOfRemote: true,
    });
    const r: ReconcileResult = await reconcileBase('/repo', 'main', 'origin', i);
    expect(r.kind).toBe('ff');
    expect(i.log).toContain('merge:origin/main');
  });

  it('local-ahead → keep as-is (no merge)', async () => {
    const i = makeIo({
      local: 'L',
      remote: 'R',
      remoteAncestorOfLocal: true,
      localAncestorOfRemote: false,
    });
    const r = await reconcileBase('/repo', 'main', 'origin', i);
    expect(r.kind).toBe('kept-local');
    expect(i.log.some((l) => l.startsWith('merge:'))).toBe(false);
  });

  it('diverged → merge both; conflict → surface', async () => {
    const ok = makeIo({
      local: 'L',
      remote: 'R',
      remoteAncestorOfLocal: false,
      localAncestorOfRemote: false,
    });
    expect((await reconcileBase('/repo', 'main', 'origin', ok)).kind).toBe('merged');

    const bad = makeIo({
      local: 'L',
      remote: 'R',
      remoteAncestorOfLocal: false,
      localAncestorOfRemote: false,
      mergeThrows: true,
    });
    const r = await reconcileBase('/repo', 'main', 'origin', bad);
    expect(r).toMatchObject({ kind: 'conflict' });
    expect(bad.log).toContain('abort');
  });

  it('equal tips → ff no-op', async () => {
    const i = makeIo({
      local: 'SAME',
      remote: 'SAME',
      remoteAncestorOfLocal: true,
      localAncestorOfRemote: true,
    });
    expect((await reconcileBase('/repo', 'main', 'origin', i)).kind).toBe('ff');
  });
});

describe('featBranchFromTitle — semantic (parallelism-ready)', () => {
  it('slugs the title under feat/', () => {
    expect(featBranchFromTitle('Fix the loop git-flow INTEGRATION')).toBe(
      'feat/fix-the-loop-git-flow-integration',
    );
  });
});
