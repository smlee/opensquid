/** AGF.6 (wg-b9c7c21cb124) — openStagePr (auth→PR, no-auth→GhAuthError, NEVER auto-merges) + tagMainRelease
 *  (prefix-scoped locked tag). Stubbed GhIo — NO real gh/git/network. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  openStagePr,
  ensureProductionPr,
  tagMainRelease,
  GhAuthError,
  type GhIo,
} from './stage_pr.js';
import type { ResolvedEnvironments } from '../../packs/discovery.js';

const cfg = { strategy: 'locked-prefix', prefix: '0.5', bump: 'patch-per-release' } as const;

function io(over: Partial<GhIo> = {}): GhIo & { pr: unknown[][]; tags: string[] } {
  const pr: unknown[][] = [];
  const tags: string[] = [];
  const base: GhIo = {
    ghAuthOk: () => Promise.resolve(true),
    prView: () => Promise.resolve(null), // default: no existing PR open
    prCreate: (a) => (pr.push([a]), Promise.resolve('https://example/pr/7')),
    latestPrefixTag: () => Promise.resolve('v0.5.547'),
    tagPush: (t) => (tags.push(t), Promise.resolve()),
    ...over,
  };
  return Object.assign(base, { pr, tags });
}

describe('AGF.6 openStagePr — the human MERGE is the sole gate', () => {
  it('auth ok → gh pr create --base main --head stage, returns the url, NO merge call anywhere', async () => {
    const i = io();
    const r = await openStagePr('t', 'b', '/repo', i);
    expect(r.url).toBe('https://example/pr/7');
    expect(i.pr).toHaveLength(1);
    expect((i.pr[0] as { base: string; head: string }[])[0]).toMatchObject({
      base: 'main',
      head: 'stage',
    });
  });

  it('FAIL-CLOSED: no gh auth → GhAuthError, prCreate NOT called (no PR silently dropped)', async () => {
    const i = io({ ghAuthOk: () => Promise.resolve(false) });
    await expect(openStagePr('t', 'b', '/repo', i)).rejects.toBeInstanceOf(GhAuthError);
    expect(i.pr).toHaveLength(0);
  });

  it('the module never shells `gh pr merge` (step 5 is deliberately NOT automated)', () => {
    const src = readFileSync(join(__dirname, 'stage_pr.ts'), 'utf8');
    expect(src).not.toMatch(/pr['"\s,]*merge|pr merge/);
  });
});

describe('GF.7 ensureProductionPr — idempotent, config-driven head/base, human MERGE is the sole gate', () => {
  it('has-stage: head=staging, base=production; prView null → prCreate ONCE with base main head stage', async () => {
    const i = io();
    const env: ResolvedEnvironments = { production: 'main', staging: 'stage', local: 'feat/x' };
    const r = await ensureProductionPr(env, '/repo', i);
    expect(r.url).toBe('https://example/pr/7');
    expect(i.pr).toHaveLength(1);
    expect((i.pr[0] as { base: string; head: string }[])[0]).toMatchObject({
      base: 'main',
      head: 'stage',
    });
  });

  it('no-stage: head falls back to local (feat/x), base=production', async () => {
    const i = io();
    const env: ResolvedEnvironments = { production: 'main', local: 'feat/x' };
    const r = await ensureProductionPr(env, '/repo', i);
    expect(r.url).toBe('https://example/pr/7');
    expect(i.pr).toHaveLength(1);
    expect((i.pr[0] as { base: string; head: string }[])[0]).toMatchObject({
      base: 'main',
      head: 'feat/x',
    });
  });

  it('idempotent: an existing open PR → returns its url, prCreate NOT called', async () => {
    const i = io({ prView: () => Promise.resolve('https://existing/pr/1') });
    const env: ResolvedEnvironments = { production: 'main', staging: 'stage', local: 'feat/x' };
    const r = await ensureProductionPr(env, '/repo', i);
    expect(r.url).toBe('https://existing/pr/1');
    expect(i.pr).toHaveLength(0);
  });

  it('FAIL-VISIBLE: no gh auth → GhAuthError, neither prView nor prCreate called', async () => {
    let viewed = false;
    const i = io({
      ghAuthOk: () => Promise.resolve(false),
      prView: () => ((viewed = true), Promise.resolve(null)),
    });
    const env: ResolvedEnvironments = { production: 'main', staging: 'stage', local: 'feat/x' };
    await expect(ensureProductionPr(env, '/repo', i)).rejects.toBeInstanceOf(GhAuthError);
    expect(viewed).toBe(false);
    expect(i.pr).toHaveLength(0);
  });
});

describe('AGF.6 tagMainRelease — prefix-scoped locked release tag → triggers publish.yml', () => {
  it('v0.5.547 latest → pushes v0.5.548', async () => {
    const i = io();
    expect(await tagMainRelease(cfg, '/repo', i)).toBe('v0.5.548');
    expect(i.tags).toEqual(['v0.5.548']);
  });
  it('an OFF-prefix latest (v0.7.2) + prefix 0.5 → v0.5.0 (never v0.7.3)', async () => {
    const i = io({ latestPrefixTag: () => Promise.resolve('v0.7.2') });
    expect(await tagMainRelease(cfg, '/repo', i)).toBe('v0.5.0');
  });
});
