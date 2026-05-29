/**
 * Tests for the `opensquid setup wizard hooks` CLI subcommand (G.1 — wiring).
 *
 * Two surfaces are tested here:
 *   1. `resolveTargets` — produces the right (user, project) settings.json
 *      paths given an injected cwd + home.
 *   2. `runHooksWizard` — calls the writer for each target (or skips it on
 *      `--dry-run`).
 *
 * The settings-writer itself is tested in `../wizard/settings-writer.test.ts`;
 * here we use stubs so this layer's responsibilities (target resolution +
 * iteration + dry-run gating) are isolated.
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveTargets, runHooksWizard } from './hooks.js';

let root: string;
let stdoutBuf: string;
let stderrBuf: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'opensquid-hooks-cli-'));
  stdoutBuf = '';
  stderrBuf = '';
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const recordStdout = (s: string): void => {
  stdoutBuf += s;
};
const recordStderr = (s: string): void => {
  stderrBuf += s;
};

describe('resolveTargets', () => {
  it('returns the user settings.json + null project when no .opensquid is found in or above cwd', async () => {
    const fakeHome = join(root, 'home');
    const fakeCwd = join(root, 'somewhere', 'else');
    await mkdir(fakeCwd, { recursive: true });

    const t = await resolveTargets({ cwd: () => fakeCwd, home: () => fakeHome });
    expect(t.user).toBe(join(fakeHome, '.claude', 'settings.json'));
    // Walk may find a real ancestor on the developer machine; if so, it
    // at least won't be one of our tmpdir fixtures.
    if (t.project !== null) {
      expect(t.project.startsWith(root)).toBe(false);
    }
  });

  it("returns project settings.json = sibling of cwd's .opensquid ancestor", async () => {
    const fakeHome = join(root, 'home');
    const projRoot = join(root, 'proj');
    await mkdir(join(projRoot, '.opensquid'), { recursive: true });
    const nested = join(projRoot, 'src', 'sub');
    await mkdir(nested, { recursive: true });

    const t = await resolveTargets({ cwd: () => nested, home: () => fakeHome });
    expect(t.user).toBe(join(fakeHome, '.claude', 'settings.json'));
    expect(t.project).toBe(join(projRoot, '.claude', 'settings.json'));
  });
});

describe('runHooksWizard — dry-run', () => {
  it('reads each target and prints a counts preview without invoking the writer', async () => {
    const fakeHome = join(root, 'home');
    const fakeCwd = join(root, 'isolated'); // no .opensquid ancestor in tmpdir
    await mkdir(fakeCwd, { recursive: true });

    let writerCalls = 0;
    let readerCalls = 0;

    await runHooksWizard(
      { dryRun: true, userOnly: true },
      {
        writer: () => {
          writerCalls += 1;
          return Promise.resolve({ added: 4, replaced: 0, preserved: 0, backupPath: 'nope' });
        },
        reader: () => {
          readerCalls += 1;
          return Promise.resolve({});
        },
        cwd: () => fakeCwd,
        home: () => fakeHome,
        stdout: recordStdout,
        stderr: recordStderr,
      },
    );

    expect(writerCalls).toBe(0);
    expect(readerCalls).toBe(1); // user-only mode
    expect(stdoutBuf).toContain('DRY RUN');
    expect(stdoutBuf).toContain('would add 5');
    expect(stderrBuf).toBe('');
  });
});

describe('runHooksWizard — write mode', () => {
  it('calls the writer once for the user target (--user-only flag)', async () => {
    const fakeHome = join(root, 'home');
    const fakeCwd = join(root, 'isolated');
    await mkdir(fakeCwd, { recursive: true });

    const seenPaths: string[] = [];
    await runHooksWizard(
      { userOnly: true },
      {
        writer: (p) => {
          seenPaths.push(p);
          return Promise.resolve({ added: 4, replaced: 0, preserved: 0, backupPath: `${p}.bak` });
        },
        cwd: () => fakeCwd,
        home: () => fakeHome,
        stdout: recordStdout,
        stderr: recordStderr,
      },
    );

    expect(seenPaths).toEqual([join(fakeHome, '.claude', 'settings.json')]);
    expect(stdoutBuf).toContain('added 4');
    expect(stderrBuf).toBe('');
  });

  it('calls the writer for both user + project when a project scope is detected', async () => {
    const fakeHome = join(root, 'home');
    const projRoot = join(root, 'proj');
    await mkdir(join(projRoot, '.opensquid'), { recursive: true });
    const nested = join(projRoot, 'src');
    await mkdir(nested, { recursive: true });

    const seenPaths: string[] = [];
    await runHooksWizard(
      {},
      {
        writer: (p) => {
          seenPaths.push(p);
          return Promise.resolve({ added: 4, replaced: 0, preserved: 0, backupPath: `${p}.bak` });
        },
        cwd: () => nested,
        home: () => fakeHome,
        stdout: recordStdout,
        stderr: recordStderr,
      },
    );

    expect(seenPaths).toEqual([
      join(fakeHome, '.claude', 'settings.json'),
      join(projRoot, '.claude', 'settings.json'),
    ]);
    expect(stderrBuf).toBe('');
  });
});
