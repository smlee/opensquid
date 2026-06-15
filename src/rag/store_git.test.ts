import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { commitMemoryStore } from './store_git.js';

const execFileP = promisify(execFile);

let home: string;
let store: string;
const savedHome = process.env.OPENSQUID_HOME;

async function git(...args: string[]): Promise<string> {
  const { stdout } = await execFileP('git', ['-C', store, ...args]);
  return stdout.trim();
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'opensquid-storegit-'));
  process.env.OPENSQUID_HOME = home;
  store = join(home, 'store');
});
afterEach(async () => {
  if (savedHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = savedHome;
  await rm(home, { recursive: true, force: true });
});

async function seed(rel: string, content: string): Promise<void> {
  const p = join(store, rel);
  await mkdir(join(p, '..'), { recursive: true });
  await writeFile(p, content, 'utf8');
}

describe('commitMemoryStore (GVM.1 — git-versioned store)', () => {
  it('returns null when the store dir does not exist (no throw)', async () => {
    expect(await commitMemoryStore('x')).toBeNull();
  });

  it('inits the repo + commits both lessons and issues; files are tracked', async () => {
    await seed('lessons/mem-a.md', '# memory a\n');
    await seed('issues/op-b.json', '{"id":"op-b"}\n');
    const sha = await commitMemoryStore('snap 1');
    expect(sha).not.toBeNull();
    expect(await git('log', '--oneline')).toContain('snap 1');
    const tracked = await git('ls-files');
    expect(tracked).toContain('lessons/mem-a.md');
    expect(tracked).toContain('issues/op-b.json');
  });

  it('is idempotent — no changes → null, no empty commit', async () => {
    await seed('lessons/mem-a.md', '# memory a\n');
    await commitMemoryStore('snap 1');
    expect(await commitMemoryStore('snap 2')).toBeNull();
    expect((await git('log', '--oneline')).split('\n')).toHaveLength(1);
  });

  it('forensic archive: a deleted memory is recoverable from prior history', async () => {
    await seed('lessons/mem-a.md', 'ORIGINAL CONTENT\n');
    await commitMemoryStore('snap 1');
    await rm(join(store, 'lessons/mem-a.md'));
    const sha2 = await commitMemoryStore('snap 2 (deleted a)');
    expect(sha2).not.toBeNull();
    // gone from the working tree, but recoverable from the prior commit
    expect(await git('show', 'HEAD~1:lessons/mem-a.md')).toContain('ORIGINAL CONTENT');
  });

  it('commits with the fixed opensquid identity (no global git config needed)', async () => {
    await seed('lessons/mem-a.md', '# a\n');
    await commitMemoryStore('snap 1');
    expect(await git('log', '-1', '--format=%an <%ae>')).toBe('opensquid <memory@opensquid.local>');
  });
});
