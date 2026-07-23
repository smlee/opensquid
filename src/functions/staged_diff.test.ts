/**
 * Tests for `stagedDiff` (GFR.1c) — the CODE audit artifact (uncommitted diff). Pure over injected readers (no
 * git, no fs): asserts the content path + the FAIL-LOUD null paths (no cwd / empty / git error / over-cap).
 */
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { MAX_AUDIT_TEXT_BYTES } from '../runtime/audit_schema.js';

import { readGitWorkingTreeDiff, stagedDiff, type DiffDeps } from './staged_diff.js';

const execFileP = promisify(execFile);

const deps = (over: Partial<DiffDeps> = {}): DiffDeps => ({
  cwd: () => Promise.resolve('/repo'),
  run: () => Promise.resolve('diff --git a/x b/x\n@@ -1 +1 @@\n+added line\n'),
  ...over,
});

describe('stagedDiff', () => {
  it('returns the diff content', async () => {
    const d = await stagedDiff('s', deps());
    expect(d).toContain('+added line');
  });

  it('returns null (fail-loud) on no cwd / empty diff / git error', async () => {
    await expect(stagedDiff('s', deps({ cwd: () => Promise.resolve(null) }))).resolves.toBeNull();
    await expect(
      stagedDiff('s', deps({ run: () => Promise.resolve('   \n') })),
    ).resolves.toBeNull();
    await expect(
      stagedDiff(
        's',
        deps({
          run: () => Promise.reject(new Error('git fail')),
        }),
      ),
    ).resolves.toBeNull();
  });

  it('returns null when over-cap (never a partial/truncated diff)', async () => {
    const huge = 'x'.repeat(MAX_AUDIT_TEXT_BYTES + 1);
    await expect(stagedDiff('s', deps({ run: () => Promise.resolve(huge) }))).resolves.toBeNull();
  });

  it('includes untracked source files without mutating the git index', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'opensquid-complete-diff-'));
    try {
      await execFileP('git', ['init'], { cwd });
      await execFileP('git', ['config', 'user.name', 'Test'], { cwd });
      await execFileP('git', ['config', 'user.email', 'test@example.com'], { cwd });
      await writeFile(join(cwd, 'tracked.txt'), 'base\n');
      await execFileP('git', ['add', 'tracked.txt'], { cwd });
      await execFileP('git', ['commit', '-m', 'base'], { cwd });
      await mkdir(join(cwd, 'src'));
      await writeFile(join(cwd, 'src', 'add.js'), 'export const add = (a, b) => a + b;\n');

      const diff = await readGitWorkingTreeDiff(cwd);

      expect(diff).toContain('diff --git a/src/add.js b/src/add.js');
      expect(diff).toContain('+export const add = (a, b) => a + b;');
      const { stdout } = await execFileP('git', ['diff', '--cached', '--name-only'], { cwd });
      expect(stdout).toBe('');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
