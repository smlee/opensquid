/** ensurePr — view||create idempotency; fail-closed auth (stubbed, no network). */
import { describe, it, expect } from 'vitest';
import { ensurePr, type EnsurePrIo } from './ensure_pr.js';
import { GhAuthError } from './stage_pr.js';

function io(over: Partial<EnsurePrIo> = {}): EnsurePrIo & { creates: number; views: number } {
  const out = {
    creates: 0,
    views: 0,
    ghAuthOk: () => Promise.resolve(true),
    prCreate: () => {
      out.creates++;
      return Promise.resolve('https://example/pr/new');
    },
    prView: () => {
      out.views++;
      return Promise.resolve(null);
    },
    latestPrefixTag: () => Promise.resolve(null),
    tagPush: () => Promise.resolve(),
    ...over,
  };
  return out;
}

describe('ensurePr', () => {
  it('creates when none open', async () => {
    const i = io();
    const r = await ensurePr(
      { base: 'main', head: 'stage', title: 't', body: 'b' },
      '/repo',
      i,
    );
    expect(r).toEqual({ url: 'https://example/pr/new', created: true });
    expect(i.creates).toBe(1);
  });

  it('reuses existing open PR (idempotent)', async () => {
    const i = io({ prView: () => Promise.resolve('https://example/pr/7') });
    const r = await ensurePr(
      { base: 'main', head: 'stage', title: 't', body: 'b' },
      '/repo',
      i,
    );
    expect(r).toEqual({ url: 'https://example/pr/7', created: false });
    expect(i.creates).toBe(0);
  });

  it('no auth → GhAuthError', async () => {
    const i = io({ ghAuthOk: () => Promise.resolve(false) });
    await expect(
      ensurePr({ base: 'main', head: 'stage', title: 't', body: 'b' }, '/repo', i),
    ).rejects.toBeInstanceOf(GhAuthError);
  });
});
