import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { completeInteractiveScope } from './scope_done.js';

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('completeInteractiveScope', () => {
  it('validates the open item and records the contained artifact through the single checkpoint writer', async () => {
    const project = await mkdtemp(join(tmpdir(), 'opensquid-scope-done-'));
    cleanup.push(project);
    await mkdir(join(project, 'docs', 'research'), { recursive: true });
    await writeFile(join(project, 'docs', 'research', 'scope.md'), '# scope\n');
    const assertOpen = vi.fn(() => Promise.resolve());
    const advance = vi.fn(() => Promise.resolve());
    await expect(
      completeInteractiveScope(
        { wgId: 'wg-1', artifact: 'docs/research/scope.md', cwd: project },
        { assertOpen, advance },
      ),
    ).resolves.toMatchObject({ wgId: 'wg-1', stage: 'scope_write' });
    const canonicalProject = await realpath(project);
    expect(assertOpen).toHaveBeenCalledWith('wg-1', canonicalProject);
    expect(advance).toHaveBeenCalledWith(
      'wg-1',
      join(canonicalProject, 'docs', 'research', 'scope.md'),
    );
  });

  it('rejects an artifact outside the project before checkpoint mutation', async () => {
    const project = await mkdtemp(join(tmpdir(), 'opensquid-scope-project-'));
    const outside = await mkdtemp(join(tmpdir(), 'opensquid-scope-outside-'));
    cleanup.push(project, outside);
    const artifact = join(outside, 'scope.md');
    await writeFile(artifact, '# outside\n');
    const advance = vi.fn();
    await expect(
      completeInteractiveScope(
        { wgId: 'wg-1', artifact, cwd: project },
        { assertOpen: vi.fn(), advance },
      ),
    ).rejects.toThrow(/escapes/);
    expect(advance).not.toHaveBeenCalled();
  });
});
