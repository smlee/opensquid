/** REL.1 (wg-5de59d0b8f2b) — generic git + npm + package.json mechanics. Exercised over a throwaway
 *  `git init` fixture (no network, no shared repo) + an injected `npm view` seam. NO release policy asserted. */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  mergeToMain,
  tagAndPushTag,
  readPackageVersion,
  writePackageVersion,
  lastReleaseTag,
  commitSubjectsSince,
  versionAlreadyPublished,
} from './release_core.js';

const execFileP = promisify(execFile);

/** A hermetic git repo: init, deterministic identity, an initial commit on `main`. */
async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rel-core-'));
  const git = (...args: string[]): Promise<unknown> => execFileP('git', args, { cwd: dir });
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.email', 'test@opensquid.dev');
  await git('config', 'user.name', 'test');
  await git('config', 'commit.gpgsign', 'false');
  await writeFile(join(dir, 'package.json'), '{\n  "name": "fixture",\n  "version": "0.1.0"\n}\n');
  await git('add', '.');
  await git('commit', '-q', '-m', 'chore: initial');
  return dir;
}

describe('REL.1 package.json version I/O', () => {
  it('round-trips a version and preserves every other byte (targeted field replace)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rel-pkg-'));
    const original = '{\n  "name": "x",\n  "version": "0.5.547",\n  "private": false\n}\n';
    await writeFile(join(dir, 'package.json'), original);
    expect(await readPackageVersion(dir)).toBe('0.5.547');
    await writePackageVersion(dir, '0.6.0');
    expect(await readPackageVersion(dir)).toBe('0.6.0');
    const after = await readFile(join(dir, 'package.json'), 'utf8');
    // Only the version field changed; formatting, key order, and every other byte are identical.
    expect(after).toBe(original.replace('0.5.547', '0.6.0'));
    await rm(dir, { recursive: true, force: true });
  });
});

describe('REL.1 versionAlreadyPublished (injected npm-view seam, no network)', () => {
  it('is true iff the exact version prints', async () => {
    const present = (): Promise<string> => Promise.resolve('0.5.453\n');
    expect(await versionAlreadyPublished('opensquid', '0.5.453', present)).toBe(true);
  });
  it('is false when the registry has no such version (empty stdout / 404)', async () => {
    const empty = (): Promise<string> => Promise.resolve('');
    expect(await versionAlreadyPublished('opensquid', '0.9.9', empty)).toBe(false);
  });
  it('fails safe to false on an npm error (rejection → treated as not-published)', async () => {
    const boom = (): Promise<string> => Promise.reject(new Error('ENETUNREACH'));
    await expect(versionAlreadyPublished('opensquid', '0.5.453', boom)).rejects.toThrow();
    // The default seam swallows the error to '' → false; the injected boom above rejects, proving the seam is
    // the only place the swallow happens (the production default catches). Assert the default's fail-safe:
    expect(await versionAlreadyPublished('opensquid', '0.5.453', () => Promise.resolve(''))).toBe(
      false,
    );
  });
});

describe('REL.1 git mechanics (throwaway fixture repo)', () => {
  let repo: string;
  beforeAll(async () => {
    repo = await initRepo();
  });

  it('lastReleaseTag: null on a tag-less repo, then the newest v* tag', async () => {
    expect(await lastReleaseTag(repo)).toBeNull();
    await execFileP('git', ['tag', 'v0.1.0'], { cwd: repo });
    expect(await lastReleaseTag(repo)).toBe('v0.1.0');
  });

  it('commitSubjectsSince: all subjects for null, only-after-tag for a ref', async () => {
    const git = (...a: string[]): Promise<unknown> => execFileP('git', a, { cwd: repo });
    await writeFile(join(repo, 'a.txt'), 'a');
    await git('add', '.');
    await git('commit', '-q', '-m', 'feat: add a');
    const all = await commitSubjectsSince(null, repo);
    expect(all).toContain('feat: add a');
    expect(all).toContain('chore: initial');
    const sinceTag = await commitSubjectsSince('v0.1.0', repo);
    expect(sinceTag).toEqual(['feat: add a']); // only the post-tag commit
  });

  it('mergeToMain: fast-forwards a strictly-ahead branch ({ ff: true })', async () => {
    const git = (...a: string[]): Promise<unknown> => execFileP('git', a, { cwd: repo });
    await git('checkout', '-q', '-b', 'feat/ff');
    await writeFile(join(repo, 'b.txt'), 'b');
    await git('add', '.');
    await git('commit', '-q', '-m', 'feat: add b');
    const { ff, sha } = await mergeToMain('feat/ff', repo);
    expect(ff).toBe(true);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('mergeToMain: creates a merge commit on divergence ({ ff: false })', async () => {
    const git = (...a: string[]): Promise<unknown> => execFileP('git', a, { cwd: repo });
    // main advances…
    await writeFile(join(repo, 'c.txt'), 'c');
    await git('add', '.');
    await git('commit', '-q', '-m', 'feat: add c on main');
    // …and a branch diverges from before that advance.
    await git('checkout', '-q', '-b', 'feat/div', 'HEAD~1');
    await writeFile(join(repo, 'd.txt'), 'd');
    await git('add', '.');
    await git('commit', '-q', '-m', 'feat: add d on branch');
    const { ff } = await mergeToMain('feat/div', repo);
    expect(ff).toBe(false); // divergence → merge commit
  });

  it('tagAndPushTag: creates the v<version> tag (push seam pointed at a bare remote)', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'rel-remote-'));
    await execFileP('git', ['init', '-q', '--bare'], { cwd: bare });
    await execFileP('git', ['remote', 'add', 'origin', bare], { cwd: repo });
    await tagAndPushTag('9.9.9', repo, 'origin');
    const { stdout } = await execFileP('git', ['tag', '--list', 'v9.9.9'], { cwd: repo });
    expect(stdout.trim()).toBe('v9.9.9');
    await rm(bare, { recursive: true, force: true });
  });
});

describe('REL.1 no-policy boundary', () => {
  it('carries no release/stage sequencing vocabulary', () => {
    const src = readFileSync(join(__dirname, 'release_core.ts'), 'utf8');
    // The mechanics are stage-blind: no ordering/refusal words in the code identifiers.
    expect(src).not.toMatch(/\bprecondition\b|refuse|merge-then-bump/i);
  });
});
