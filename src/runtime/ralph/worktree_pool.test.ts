/** AGF.3 (wg-4ae1004c931b) — the bounded pool + worktree-per-item, driven with a STUBBED WorktreeIo (no real git).
 *  Asserts: ≤bound concurrency, ALL items complete, add-once/remove-once per item, and a driven-item FAULT is
 *  isolated (the other items complete, the faulted worktree is still torn down, the drain never breaks). */
import { describe, it, expect } from 'vitest';
import { drainPool, addItemWorktree, type WorktreeIo } from './worktree_pool.js';

function io(): WorktreeIo & { added: string[]; removed: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  return {
    added,
    removed,
    worktreeAdd: (_b, path) => (added.push(path), Promise.resolve()),
    worktreeRemove: (path) => (removed.push(path), Promise.resolve()),
  };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 1));

describe('AGF.3 addItemWorktree (dormant)', () => {
  it('uses the caller-selected semantic branch and base while keeping the WorkGraph id only in the path', async () => {
    const i = io();
    let call: unknown[] = [];
    const spy: WorktreeIo = { ...i, worktreeAdd: (...a) => ((call = a), Promise.resolve()) };
    const path = await addItemWorktree(
      'wg-x',
      'feat/improve-deploy-policy',
      'trunk',
      '/main',
      '/pool',
      spy,
    );
    expect(path).toBe('/pool/wg-x');
    expect(call).toEqual(['feat/improve-deploy-policy', '/pool/wg-x', 'trunk', '/main']);
  });
});

describe('AGF.3 drainPool', () => {
  it('runs at most `bound` concurrently and completes ALL claimed items (add/remove once each)', async () => {
    const i = io();
    const ids = ['a', 'b', 'c', 'd', 'e'];
    let idx = 0;
    let inFlight = 0;
    let maxSeen = 0;
    const claimNext = (): Promise<{ id: string; branch: string } | null> =>
      Promise.resolve(
        idx < ids.length ? { id: ids[idx]!, branch: `feat/task-${ids[idx++]!}` } : null,
      );
    const out = await drainPool<string>(
      { bound: 2, baseBranch: 'trunk', poolRoot: '/pool', mainRoot: '/main' },
      claimNext,
      async (item) => {
        inFlight++;
        maxSeen = Math.max(maxSeen, inFlight);
        await tick();
        inFlight--;
        return item.id;
      },
      i,
    );
    expect(out.sort()).toEqual(ids);
    expect(maxSeen).toBeLessThanOrEqual(2);
    expect(i.added.sort()).toEqual(ids.map((x) => `/pool/${x}`).sort());
    expect(i.removed.sort()).toEqual(ids.map((x) => `/pool/${x}`).sort());
  });

  it('a driven-item FAULT is isolated — the others complete + the faulted worktree is torn down', async () => {
    const i = io();
    const ids = ['a', 'b', 'c', 'd', 'e'];
    let idx = 0;
    const out = await drainPool<string>(
      { bound: 2, baseBranch: 'trunk', poolRoot: '/pool', mainRoot: '/main' },
      () =>
        Promise.resolve(
          idx < ids.length ? { id: ids[idx]!, branch: `feat/task-${ids[idx++]!}` } : null,
        ),
      async (item) => {
        await tick();
        if (item.id === 'c') throw new Error('boom');
        return item.id;
      },
      i,
    );
    expect(out.sort()).toEqual(['a', 'b', 'd', 'e']); // 'c' dropped, drain never broke
    expect(i.removed).toContain('/pool/c'); // the faulted worktree is STILL torn down (finally)
    expect(i.removed).toHaveLength(5);
  });
});
