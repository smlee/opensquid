import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkGitHooks, installGitHooks, OPENSQUID_HOOK_MARKER } from './git-hooks.js';

let repo: string;
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'opensquid-githooks-'));
  await mkdir(join(repo, '.git', 'hooks'), { recursive: true });
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('GF.2 — git-hooks installer', () => {
  it('installs both managed hooks (marker + gate call); check reports installed', async () => {
    const res = await installGitHooks(repo);
    expect(res).toEqual([
      { name: 'pre-commit', state: 'installed' },
      { name: 'pre-push', state: 'installed' },
    ]);
    const body = await readFile(join(repo, '.git', 'hooks', 'pre-commit'), 'utf8');
    expect(body).toContain(OPENSQUID_HOOK_MARKER);
    expect(body).toContain('opensquid gate commit');
    expect(await checkGitHooks(repo)).toEqual([
      { name: 'pre-commit', state: 'installed' },
      { name: 'pre-push', state: 'installed' },
    ]);
  });

  it('is idempotent on re-install', async () => {
    await installGitHooks(repo);
    const res = await installGitHooks(repo);
    expect(res.every((h) => h.state === 'installed')).toBe(true);
  });

  it('CHAINS a foreign hook instead of clobbering it', async () => {
    const path = join(repo, '.git', 'hooks', 'pre-commit');
    await writeFile(path, '#!/bin/sh\necho mine\n', 'utf8');
    const res = await installGitHooks(repo);
    expect(res.find((h) => h.name === 'pre-commit')?.state).toBe('foreign');
    const body = await readFile(path, 'utf8');
    expect(body).toContain('echo mine'); // user's hook preserved
    expect(body).toContain('opensquid gate commit'); // gate call chained on
    expect(body).toContain(OPENSQUID_HOOK_MARKER);
  });

  it('check reports missing when no hooks present', async () => {
    expect(await checkGitHooks(repo)).toEqual([
      { name: 'pre-commit', state: 'missing' },
      { name: 'pre-push', state: 'missing' },
    ]);
  });
});
