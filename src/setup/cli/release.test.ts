/** REL.4 (wg-7bf3ae9f592b) — the `opensquid release` sequence, driven through injected seams (NO live git/npm).
 *  Asserts: refuse-red / refuse-behind fire BEFORE any mutation; green+releasable runs merge→bump→tag in order;
 *  a null bump skips bump+tag; the module never publishes. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { runRelease, type ReleaseDeps } from './release.js';

/** A green, up-to-date baseline with spies on every effect; the caller overrides the history/version. */
interface Calls {
  merge: unknown[][];
  tagPush: unknown[][];
  writeVersion: unknown[][];
  commitBump: unknown[][];
}
function deps(over: Partial<ReleaseDeps> = {}): ReleaseDeps & { calls: Calls } {
  const calls: Calls = { merge: [], tagPush: [], writeVersion: [], commitBump: [] };
  const rec =
    (k: keyof Calls) =>
    (...a: unknown[]): void => {
      calls[k].push(a);
    };
  const base: ReleaseDeps = {
    currentBranch: () => Promise.resolve('feat/x'),
    suiteGreen: () => Promise.resolve(true),
    upToDateWithMain: () => Promise.resolve(true),
    merge: (...a) => {
      rec('merge')(...a);
      return Promise.resolve({ sha: 'abcdef0123456789', ff: true });
    },
    tagPush: (...a) => {
      rec('tagPush')(...a);
      return Promise.resolve();
    },
    lastTag: () => Promise.resolve('v0.5.547'),
    subjectsSince: () => Promise.resolve(['feat: a new thing']),
    readVersion: () => Promise.resolve('0.5.547'),
    writeVersion: (...a) => {
      rec('writeVersion')(...a);
      return Promise.resolve();
    },
    commitBump: (...a) => {
      rec('commitBump')(...a);
      return Promise.resolve();
    },
    ...over,
  };
  return Object.assign(base, { calls });
}

describe('REL.4 precondition (refuse-red / refuse-behind)', () => {
  it('a RED suite → non-zero exit, NO merge/tag side effect', async () => {
    const d = deps({ suiteGreen: () => Promise.resolve(false) });
    expect(await runRelease('/repo', d)).not.toBe(0);
    expect(d.calls.merge).toHaveLength(0);
    expect(d.calls.tagPush).toHaveLength(0);
  });

  it('BEHIND main → non-zero exit, NO merge', async () => {
    const d = deps({ upToDateWithMain: () => Promise.resolve(false) });
    expect(await runRelease('/repo', d)).not.toBe(0);
    expect(d.calls.merge).toHaveLength(0);
  });
});

describe('REL.4 happy path (green + up-to-date + releasable history)', () => {
  it('runs merge → bump → tag in order, bumping the minor for a feat', async () => {
    const d = deps({ subjectsSince: () => Promise.resolve(['feat: a', 'fix: b']) });
    expect(await runRelease('/repo', d)).toBe(0);
    expect(d.calls.merge).toHaveLength(1);
    expect(d.calls.merge[0]).toEqual(['feat/x', '/repo']);
    expect(d.calls.writeVersion[0]).toEqual(['/repo', '0.6.0']); // feat → minor from 0.5.547
    expect(d.calls.commitBump[0]).toEqual(['0.6.0', '/repo']); // bump committed BEFORE the tag
    expect(d.calls.tagPush[0]).toEqual(['0.6.0', '/repo']);
  });

  it('bumps the patch for a fix-only history', async () => {
    const d = deps({ subjectsSince: () => Promise.resolve(['fix: b']) });
    expect(await runRelease('/repo', d)).toBe(0);
    expect(d.calls.writeVersion[0]).toEqual(['/repo', '0.5.548']);
  });
});

describe('REL.4 skip-when-nothing-releasable (the ask no-op)', () => {
  it('merges but does NOT bump/tag when bumpLevel is null (chore-only history)', async () => {
    const d = deps({ subjectsSince: () => Promise.resolve(['chore: deps', 'docs: readme']) });
    expect(await runRelease('/repo', d)).toBe(0);
    expect(d.calls.merge).toHaveLength(1); // the merge still happens
    expect(d.calls.writeVersion).toHaveLength(0); // …but no bump
    expect(d.calls.tagPush).toHaveLength(0); // …and no tag
  });
});

describe('REL.4 does NOT publish', () => {
  it('the module contains no local `npm publish`', () => {
    const src = readFileSync(join(__dirname, 'release.ts'), 'utf8');
    expect(src).not.toMatch(/execFileP\(\s*'npm'|'publish'/); // no npm-publish invocation in the local command
  });
});
