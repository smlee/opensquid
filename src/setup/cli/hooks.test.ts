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

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mergeEnvironmentsBlock, resolveTargets, runHooksWizard } from './hooks.js';

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
    expect(stdoutBuf).toContain('would add 6');
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

describe('runHooksWizard — project context.md (T-project-context)', () => {
  // Common deps: stub the settings writer + silence the agents step (no harnesses).
  const baseDeps = (cwd: string, home: string) => ({
    writer: (p: string) =>
      Promise.resolve({ added: 4, replaced: 0, preserved: 0, backupPath: `${p}.bak` }),
    cwd: () => cwd,
    home: () => home,
    hasBinary: () => Promise.resolve(false),
    stdout: recordStdout,
    stderr: recordStderr,
  });
  const readCtx = (projRoot: string) =>
    readFile(join(projRoot, '.opensquid', 'context.md'), 'utf8');

  it('scaffolds context.md (seeded with the detected package manager) when absent', async () => {
    const projRoot = join(root, 'proj');
    await mkdir(join(projRoot, '.opensquid'), { recursive: true });
    await writeFile(join(projRoot, 'pnpm-lock.yaml'), '', 'utf8');

    await runHooksWizard({}, baseDeps(projRoot, join(root, 'home')));

    expect(await readCtx(projRoot)).toMatch(/package_manager: pnpm/);
    expect(stdoutBuf).toContain('context: created');
  });

  it('still scaffolds a starter when NO package manager is detected', async () => {
    const projRoot = join(root, 'proj');
    await mkdir(join(projRoot, '.opensquid'), { recursive: true });

    await runHooksWizard({}, baseDeps(projRoot, join(root, 'home')));

    expect(await readCtx(projRoot)).toMatch(/project context/i); // free-form starter written
    expect(stdoutBuf).toContain('context: created');
  });

  it('NEVER overwrites an existing user-authored context.md', async () => {
    const projRoot = join(root, 'proj');
    await mkdir(join(projRoot, '.opensquid'), { recursive: true });
    await writeFile(join(projRoot, 'pnpm-lock.yaml'), '', 'utf8');
    const mine = '---\nforbid:\n  - rm -rf /\n---\n# mine\n';
    await writeFile(join(projRoot, '.opensquid', 'context.md'), mine, 'utf8');

    await runHooksWizard({}, baseDeps(projRoot, join(root, 'home')));

    expect(await readCtx(projRoot)).toBe(mine); // untouched
    expect(stdoutBuf).toContain('already exists');
  });

  it('--no-context opt-out skips scaffolding', async () => {
    const projRoot = join(root, 'proj');
    await mkdir(join(projRoot, '.opensquid'), { recursive: true });
    await writeFile(join(projRoot, 'pnpm-lock.yaml'), '', 'utf8');

    await runHooksWizard({ context: false }, baseDeps(projRoot, join(root, 'home')));

    await expect(readCtx(projRoot)).rejects.toThrow();
    expect(stdoutBuf).not.toContain('context:');
  });

  it('dry-run previews the scaffold without touching disk', async () => {
    const projRoot = join(root, 'proj');
    await mkdir(join(projRoot, '.opensquid'), { recursive: true });
    await writeFile(join(projRoot, 'pnpm-lock.yaml'), '', 'utf8');

    await runHooksWizard({ dryRun: true }, baseDeps(projRoot, join(root, 'home')));

    expect(stdoutBuf).toMatch(/would scaffold .*context\.md if absent/);
    await expect(readCtx(projRoot)).rejects.toThrow();
  });
});

/* ────────────────────────────────────────────────────────────────────
 * GF.1 (scope-1) — mergeEnvironmentsBlock: the PURE elicitation merge that
 * folds `version-control.environments` into an existing active.json object.
 * production is REQUIRED (trimmed); whitespace/empty staging/local are DROPPED;
 * other top-level keys are preserved; the input is NEVER mutated.
 * ──────────────────────────────────────────────────────────────────── */
describe('mergeEnvironmentsBlock — pure version-control.environments merge (GF.1)', () => {
  it('production only → environments === {production} (trimmed), staging/local absent', () => {
    const out = mergeEnvironmentsBlock({}, { production: '  main  ' });
    const vc = out['version-control'] as { environments: Record<string, unknown> };
    expect(vc.environments).toEqual({ production: 'main' });
    expect('staging' in vc.environments).toBe(false);
    expect('local' in vc.environments).toBe(false);
  });

  it('drops empty/whitespace staging and local', () => {
    const out = mergeEnvironmentsBlock({}, { production: 'main', staging: '  ', local: '' });
    const vc = out['version-control'] as { environments: Record<string, unknown> };
    expect(vc.environments).toEqual({ production: 'main' });
  });

  it('includes staging + local (trimmed) when non-empty', () => {
    const out = mergeEnvironmentsBlock(
      {},
      {
        production: 'main',
        staging: ' stage ',
        local: ' develop ',
      },
    );
    const vc = out['version-control'] as { environments: Record<string, unknown> };
    expect(vc.environments).toEqual({ production: 'main', staging: 'stage', local: 'develop' });
  });

  it('preserves existing top-level keys and merges over a prior version-control object', () => {
    const existing = {
      packs: ['fullstack-flow'],
      verifySuite: 'bash scripts/pre-push.sh',
      'version-control': { versioning: { strategy: 'locked-prefix', prefix: '0.5' } },
    };
    const out = mergeEnvironmentsBlock(existing, { production: 'main' });
    expect(out.packs).toEqual(['fullstack-flow']);
    expect(out.verifySuite).toBe('bash scripts/pre-push.sh');
    const vc = out['version-control'] as Record<string, unknown>;
    // prior versioning sub-block preserved; environments folded in.
    expect(vc.versioning).toEqual({ strategy: 'locked-prefix', prefix: '0.5' });
    expect(vc.environments).toEqual({ production: 'main' });
  });

  it('does NOT mutate the input object', () => {
    const existing: Record<string, unknown> = { packs: ['fullstack-flow'] };
    const snapshot = JSON.stringify(existing);
    const out = mergeEnvironmentsBlock(existing, { production: 'main' });
    expect(JSON.stringify(existing)).toBe(snapshot); // input unchanged
    expect(out).not.toBe(existing); // new object returned
    expect('version-control' in existing).toBe(false);
  });
});
