import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { anchorProcessToProjectDir } from './anchor.js';

describe('anchorProcessToProjectDir', () => {
  let tmpDir: string;
  let savedCwd: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'anchor-'));
    savedCwd = process.cwd();
    savedEnv = process.env.CLAUDE_PROJECT_DIR;
  });

  afterEach(() => {
    process.chdir(savedCwd);
    if (savedEnv === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = savedEnv;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('chdirs to CLAUDE_PROJECT_DIR when set', () => {
    process.env.CLAUDE_PROJECT_DIR = tmpDir;
    anchorProcessToProjectDir();
    // realpath both sides: macOS tmpdir() is a symlink (/tmp -> /private/tmp)
    expect(process.cwd()).toBe(realpathSync(tmpDir));
  });

  it('is a no-op when unset', () => {
    delete process.env.CLAUDE_PROJECT_DIR;
    const before = process.cwd();
    anchorProcessToProjectDir();
    expect(process.cwd()).toBe(before);
  });

  it('is a no-op when empty', () => {
    process.env.CLAUDE_PROJECT_DIR = '';
    const before = process.cwd();
    anchorProcessToProjectDir();
    expect(process.cwd()).toBe(before);
  });

  it('throws on a nonexistent dir (fail-loud, never a silently wrong namespace)', () => {
    process.env.CLAUDE_PROJECT_DIR = join(tmpDir, 'does-not-exist');
    expect(() => anchorProcessToProjectDir()).toThrow();
  });
});
