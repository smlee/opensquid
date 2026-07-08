/** AGF.1 (wg-01d5a9233026) — latestPrefixTag over a throwaway `git init` fixture carrying BOTH v0.5.* and an
 *  off-prefix v0.7.2. THE regression guard: it returns the highest v0.5.* and IGNORES v0.7.2 (what a naive
 *  lastReleaseTag reuse — newest v* regardless of prefix — would get wrong). No live repo. */
import { describe, it, expect, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { latestPrefixTag } from './release_core.js';

const x = promisify(execFile);
const git = (cwd: string, ...args: string[]): Promise<unknown> =>
  x('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
  });

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('AGF.1 latestPrefixTag — prefix-scoped, ignores the off-prefix newest tag', () => {
  it('returns the highest v0.5.* and IGNORES v0.7.2 (the live-repo scenario)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agf1-'));
    dirs.push(dir);
    await git(dir, 'init', '-b', 'main');
    await writeFile(join(dir, 'f'), 'x');
    await git(dir, 'add', '.');
    await git(dir, 'commit', '-m', 'c');
    for (const t of ['v0.5.3', 'v0.5.10', 'v0.7.2']) await git(dir, 'tag', t);

    expect(await latestPrefixTag('0.5', dir)).toBe('v0.5.10'); // NOT v0.7.2 (off-prefix), NOT v0.5.3
  });

  it('null when the prefix has no tag yet', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agf1-'));
    dirs.push(dir);
    await git(dir, 'init', '-b', 'main');
    await writeFile(join(dir, 'f'), 'x');
    await git(dir, 'add', '.');
    await git(dir, 'commit', '-m', 'c');
    await git(dir, 'tag', 'v0.7.2');
    expect(await latestPrefixTag('0.5', dir)).toBeNull();
  });
});
