/**
 * Unit tests for `registerMemory` — commander wiring + import-auto + snapshot-auto.
 *
 * Uses commander's `parseAsync` against in-test program instances rather
 * than spawning subprocesses. Engine + filesystem-resolver + opensquidHome
 * are injected via `MemoryCliDeps` so tests stay hermetic.
 */

import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EngineClient } from '../../engine/client.js';

import { encodeProjectPath, registerMemory } from './memory.js';

let root: string;
let home: string;
let exitCodeBefore: typeof process.exitCode;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'opensquid-memcli-'));
  home = await mkdtemp(join(tmpdir(), 'opensquid-memcli-home-'));
  exitCodeBefore = process.exitCode;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
  process.exitCode = exitCodeBefore;
});

interface Stubs {
  engineFactory: ReturnType<typeof vi.fn>;
  memoryCreate: ReturnType<typeof vi.fn>;
  memoryList: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  stdout: string[];
  stderr: string[];
}

function makeStubs(
  opts: {
    existing?: string[];
    memoryListResults?: { origin?: { host?: string } | null }[];
  } = {},
): Stubs {
  const memoryCreate = vi.fn().mockResolvedValue({
    id: 'mem-x',
    description: 'd',
    created_at: '2026-05-24T00:00:00Z',
    scope: 'user',
  });
  const results =
    opts.memoryListResults ??
    (opts.existing ?? []).map((name) => ({
      id: name,
      description: name,
      scope: 'user',
      origin: { host: `opensquid-import:auto-memory:${name}` },
      created_at: 't',
      updated_at: null,
      consumed_by_user_lessons: 0,
    }));
  const memoryList = vi.fn().mockResolvedValue({
    total: results.length,
    limit: 200,
    offset: 0,
    returned: results.length,
    results,
  });
  const close = vi.fn().mockResolvedValue(undefined);
  const engineFactory = vi.fn(
    () => ({ memoryCreate, memoryList, close }) as unknown as EngineClient,
  );
  return { engineFactory, memoryCreate, memoryList, close, stdout: [], stderr: [] };
}

async function makeFixtureDir(projectEncoded: string): Promise<string> {
  const memDir = join(root, projectEncoded, 'memory');
  await mkdir(memDir, { recursive: true });
  return memDir;
}

async function writeFixture(memDir: string, name: string, type: string): Promise<void> {
  await writeFile(
    join(memDir, `${name}.md`),
    `---\nname: ${name}\ndescription: "${name}-desc"\nmetadata:\n  type: ${type}\n---\nbody of ${name}\n`,
    'utf-8',
  );
}

function makeProgram(stubs: Stubs): Command {
  const program = new Command().exitOverride(); // don't kill the test process
  registerMemory(program, {
    engineFactory: stubs.engineFactory,
    opensquidHome: () => home,
    stdout: (s) => stubs.stdout.push(s),
    stderr: (s) => stubs.stderr.push(s),
    cwd: () => '/Users/test/proj',
  });
  return program;
}

describe('encodeProjectPath', () => {
  it('replaces every / with - including the leading slash', () => {
    expect(encodeProjectPath('/Users/alice/projects/sample')).toBe('-Users-alice-projects-sample');
  });
});

describe('opensquid memory import-auto', () => {
  it('dry-run prints summary and never calls memoryCreate', async () => {
    const memDir = await makeFixtureDir('-Users-test-proj');
    await writeFixture(memDir, 'a', 'feedback');
    await writeFixture(memDir, 'b', 'user');
    const stubs = makeStubs();
    const program = makeProgram(stubs);
    await program.parseAsync(
      ['node', 'opensquid', 'memory', 'import-auto', '--dry-run', '--auto-memory-root', root],
      { from: 'node' },
    );
    expect(stubs.memoryCreate).not.toHaveBeenCalled();
    expect(stubs.stdout.join('')).toMatch(/\[dry-run\] Imported 2, skipped 0, errors 0/);
    expect(stubs.close).toHaveBeenCalledTimes(1);
  });

  it('non-dry-run writes via engine.memoryCreate and prints summary', async () => {
    const memDir = await makeFixtureDir('-Users-test-proj');
    await writeFixture(memDir, 'a', 'feedback');
    await writeFixture(memDir, 'b', 'project');
    const stubs = makeStubs();
    const program = makeProgram(stubs);
    await program.parseAsync(
      ['node', 'opensquid', 'memory', 'import-auto', '--auto-memory-root', root],
      { from: 'node' },
    );
    expect(stubs.memoryCreate).toHaveBeenCalledTimes(2);
    expect(stubs.stdout.join('')).toMatch(/Imported 2, skipped 0, errors 0/);
  });

  it('idempotent: re-run with existing names returns 0 imported', async () => {
    const memDir = await makeFixtureDir('-Users-test-proj');
    await writeFixture(memDir, 'a', 'feedback');
    await writeFixture(memDir, 'b', 'user');
    const stubs = makeStubs({ existing: ['a', 'b'] });
    const program = makeProgram(stubs);
    await program.parseAsync(
      ['node', 'opensquid', 'memory', 'import-auto', '--auto-memory-root', root],
      { from: 'node' },
    );
    expect(stubs.memoryCreate).not.toHaveBeenCalled();
    expect(stubs.stdout.join('')).toMatch(/Imported 0, skipped 2, errors 0/);
  });

  it('--auto-memory-root with nonexistent path exits non-zero with clear stderr', async () => {
    const stubs = makeStubs();
    const program = makeProgram(stubs);
    await program.parseAsync(
      [
        'node',
        'opensquid',
        'memory',
        'import-auto',
        '--auto-memory-root',
        join(root, 'does-not-exist'),
      ],
      { from: 'node' },
    );
    expect(process.exitCode).toBe(1);
    expect(stubs.stderr.join('')).toMatch(/does not exist/);
    expect(stubs.engineFactory).not.toHaveBeenCalled();
  });

  it('--project overrides cwd and encodes the path correctly', async () => {
    const memDir = await makeFixtureDir('-Users-alice-projects-sample');
    await writeFixture(memDir, 'x', 'feedback');
    const stubs = makeStubs();
    const program = makeProgram(stubs);
    await program.parseAsync(
      [
        'node',
        'opensquid',
        'memory',
        'import-auto',
        '--auto-memory-root',
        root,
        '--project',
        '/Users/alice/projects/sample',
      ],
      { from: 'node' },
    );
    expect(stubs.memoryCreate).toHaveBeenCalledTimes(1);
    expect(stubs.stdout.join('')).toMatch(/Imported 1, skipped 0, errors 0/);
  });

  it('--help documents the flags', async () => {
    const stubs = makeStubs();
    const program = new Command().exitOverride();
    let helpText = '';
    registerMemory(program, {
      engineFactory: stubs.engineFactory,
      stdout: (s) => (helpText += s),
      stderr: (s) => (helpText += s),
      cwd: () => '/x',
    });
    program.configureOutput({ writeOut: (s) => (helpText += s), writeErr: (s) => (helpText += s) });
    try {
      await program.parseAsync(['node', 'opensquid', 'memory', 'import-auto', '--help'], {
        from: 'node',
      });
    } catch {
      /* commander exitOverride throws on --help; expected */
    }
    expect(helpText).toMatch(/--dry-run/);
    expect(helpText).toMatch(/--project/);
    expect(helpText).toMatch(/--auto-memory-root/);
  });

  it('reports per-file errors on stderr; exits non-zero when any error occurs', async () => {
    const memDir = await makeFixtureDir('-Users-test-proj');
    await writeFixture(memDir, 'good', 'feedback');
    await writeFile(join(memDir, 'bad.md'), '# no frontmatter\n', 'utf-8');
    const stubs = makeStubs();
    const program = makeProgram(stubs);
    await program.parseAsync(
      ['node', 'opensquid', 'memory', 'import-auto', '--auto-memory-root', root],
      { from: 'node' },
    );
    expect(stubs.stdout.join('')).toMatch(/Imported 1, skipped 0, errors 1/);
    expect(stubs.stderr.join('')).toMatch(/bad\.md/);
    expect(process.exitCode).toBe(1);
  });
});

describe('opensquid memory snapshot-auto', () => {
  it('first run (no snapshot file) imports ALL files and writes timestamp', async () => {
    const memDir = await makeFixtureDir('-Users-test-proj');
    await writeFixture(memDir, 'a', 'feedback');
    await writeFixture(memDir, 'b', 'user');
    const stubs = makeStubs();
    const program = makeProgram(stubs);
    await program.parseAsync(
      ['node', 'opensquid', 'memory', 'snapshot-auto', '--auto-memory-root', root],
      { from: 'node' },
    );
    expect(stubs.memoryCreate).toHaveBeenCalledTimes(2);
    expect(stubs.stdout.join('')).toMatch(/Snapshot: Imported 2, skipped 0, errors 0/);
    const stamp = await readFile(join(home, '.last-auto-memory-snapshot'), 'utf-8');
    expect(Number(stamp.trim())).toBeGreaterThan(0);
    expect(stubs.close).toHaveBeenCalledTimes(1);
  });

  it('exits non-zero with clear stderr when auto-memory-root is missing', async () => {
    const stubs = makeStubs();
    const program = makeProgram(stubs);
    await program.parseAsync(
      [
        'node',
        'opensquid',
        'memory',
        'snapshot-auto',
        '--auto-memory-root',
        join(root, 'does-not-exist'),
      ],
      { from: 'node' },
    );
    expect(process.exitCode).toBe(1);
    expect(stubs.stderr.join('')).toMatch(/snapshot-auto:.*does not exist/);
    expect(stubs.engineFactory).not.toHaveBeenCalled();
  });

  it('dedup via existingNames carries through to snapshot', async () => {
    const memDir = await makeFixtureDir('-Users-test-proj');
    await writeFixture(memDir, 'a', 'feedback');
    const stubs = makeStubs({ existing: ['a'] });
    const program = makeProgram(stubs);
    await program.parseAsync(
      ['node', 'opensquid', 'memory', 'snapshot-auto', '--auto-memory-root', root],
      { from: 'node' },
    );
    expect(stubs.memoryCreate).not.toHaveBeenCalled();
    expect(stubs.stdout.join('')).toMatch(/Snapshot: Imported 0, skipped 1, errors 0/);
  });

  it('--help documents the flags', async () => {
    const stubs = makeStubs();
    const program = new Command().exitOverride();
    let helpText = '';
    registerMemory(program, {
      engineFactory: stubs.engineFactory,
      opensquidHome: () => home,
      stdout: (s) => (helpText += s),
      stderr: (s) => (helpText += s),
      cwd: () => '/x',
    });
    program.configureOutput({ writeOut: (s) => (helpText += s), writeErr: (s) => (helpText += s) });
    try {
      await program.parseAsync(['node', 'opensquid', 'memory', 'snapshot-auto', '--help'], {
        from: 'node',
      });
    } catch {
      /* commander exitOverride throws on --help; expected */
    }
    expect(helpText).toMatch(/--project/);
    expect(helpText).toMatch(/--auto-memory-root/);
    expect(helpText).not.toMatch(/--dry-run/); // snapshot has no dry-run
  });
});
