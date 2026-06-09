/**
 * `opensquid memory` CLI verb group (G.6 + G.7).
 *
 * Verbs:
 *
 *   import-auto    — bulk-imports Claude Code auto-memory files from
 *                    `~/.claude/projects/<encoded-path>/memory/` into the
 *                    libSQL memory store via the MemoryStore handle (RES-5b, engine-free).
 *                    Dedupe by frontmatter `name` (round-tripped through the
 *                    `origin:import:` marker tag).
 *                    Flags:
 *                      --dry-run                preview without writing
 *                      --project <path>         override auto-memory project
 *                                               (default: cwd); slash → dash
 *                                               encoded per Claude Code
 *                      --auto-memory-root <p>   override `~/.claude/projects/`
 *
 *   snapshot-auto  — incremental catch-up over import-auto. Re-imports any
 *                    auto-memory file modified since the timestamp stored at
 *                    `<OPENSQUID_HOME>/.last-auto-memory-snapshot`. First run
 *                    (file absent) → imports ALL files. Reuses G.6 dedup.
 *                    Same flags as import-auto except --dry-run is omitted
 *                    (snapshot is a side-effecting maintenance verb).
 *
 * Stays harness-agnostic: the importer/snapshot module know nothing about
 * commander or the CLI surface. This file owns argument parsing + summary
 * formatting + the MemoryStore handle lifecycle (built + closed per verb).
 *
 * Imports from: commander, node:os, node:path, ../../runtime/paths.js,
 *   ../migrate/memory_store_handle.js, ../migrate/auto_memory_importer.js,
 *   ../migrate/auto_memory_snapshot.js.
 * Imported by: src/cli.ts, src/setup/cli/memory.test.ts.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import { OPENSQUID_HOME } from '../../runtime/paths.js';
import { makeMemoryStore, type MemoryStore } from '../migrate/memory_store_handle.js';
import {
  fetchExistingImportIndex,
  importAutoMemoryDir,
  type ImportResult,
} from '../migrate/auto_memory_importer.js';
import { snapshotAuto } from '../migrate/auto_memory_snapshot.js';

import type { Command } from 'commander';

export interface MemoryCliDeps {
  /** Override the memory store (tests inject a stub/tmp store). */
  storeFactory?: () => Promise<MemoryStore>;
  /** Override resolver for the auto-memory directory; tests use a tmp dir. */
  resolveAutoMemoryDir?: (root: string, projectPath: string) => string;
  /** Override opensquid-home directory (snapshot-auto target); tests use a tmp dir. */
  opensquidHome?: () => string;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  cwd?: () => string;
}

interface ImportAutoOpts {
  dryRun: boolean;
  project?: string;
  autoMemoryRoot?: string;
}

interface SnapshotAutoOpts {
  project?: string;
  autoMemoryRoot?: string;
}

/**
 * Encode a project path the way Claude Code does for the auto-memory
 * directory: every `/` becomes `-` (including the leading slash, so
 * `/Users/alice/x` → `-Users-alice-x`). Non-path inputs are passed verbatim.
 */
export function encodeProjectPath(projectPath: string): string {
  return projectPath.replace(/\//g, '-');
}

function defaultResolve(root: string, projectPath: string): string {
  return join(root, encodeProjectPath(projectPath), 'memory');
}

/** Resolve + probe the auto-memory directory; return null on miss (caller exits). */
async function resolveDir(
  deps: Required<MemoryCliDeps>,
  opts: { project?: string; autoMemoryRoot?: string },
  verb: string,
): Promise<string | null> {
  const root = opts.autoMemoryRoot ?? join(homedir(), '.claude', 'projects');
  const dir = deps.resolveAutoMemoryDir(root, opts.project ?? deps.cwd());
  const { promises: fs } = await import('node:fs');
  try {
    const stat = await fs.stat(dir);
    if (!stat.isDirectory()) {
      deps.stderr(`opensquid memory ${verb}: ${dir} is not a directory\n`);
      process.exitCode = 1;
      return null;
    }
  } catch {
    deps.stderr(`opensquid memory ${verb}: ${dir} does not exist\n`);
    process.exitCode = 1;
    return null;
  }
  return dir;
}

function reportResult(
  deps: Required<MemoryCliDeps>,
  result: ImportResult,
  prefix: string,
  dir: string,
): void {
  deps.stdout(
    `${prefix}Imported ${String(result.imported)}, refreshed ${String(result.refreshed)}, skipped ${String(result.skipped)}, errors ${String(result.errors.length)} (from ${dir})\n`,
  );
  for (const err of result.errors) {
    deps.stderr(`  error: ${err.path}: ${err.reason}\n`);
  }
  if (result.errors.length > 0) process.exitCode = 1;
}

async function actImportAuto(deps: Required<MemoryCliDeps>, opts: ImportAutoOpts): Promise<void> {
  const dir = await resolveDir(deps, opts, 'import-auto');
  if (dir === null) return;
  const store = await deps.storeFactory();
  try {
    const existingIndex = await fetchExistingImportIndex(store);
    const result = await importAutoMemoryDir(dir, store, {
      dryRun: opts.dryRun,
      existingIndex,
    });
    reportResult(deps, result, opts.dryRun ? '[dry-run] ' : '', dir);
  } finally {
    await store.close();
  }
}

async function actSnapshotAuto(
  deps: Required<MemoryCliDeps>,
  opts: SnapshotAutoOpts,
): Promise<void> {
  const dir = await resolveDir(deps, opts, 'snapshot-auto');
  if (dir === null) return;
  const store = await deps.storeFactory();
  try {
    const result = await snapshotAuto(dir, deps.opensquidHome(), store);
    reportResult(deps, result, 'Snapshot: ', dir);
  } finally {
    await store.close();
  }
}

function buildDeps(d: MemoryCliDeps): Required<MemoryCliDeps> {
  return {
    storeFactory: d.storeFactory ?? makeMemoryStore,
    resolveAutoMemoryDir: d.resolveAutoMemoryDir ?? defaultResolve,
    opensquidHome: d.opensquidHome ?? OPENSQUID_HOME,
    stdout: d.stdout ?? ((s: string): void => void process.stdout.write(s)),
    stderr: d.stderr ?? ((s: string): void => void process.stderr.write(s)),
    cwd: d.cwd ?? ((): string => process.cwd()),
  };
}

/** Register `opensquid memory` on the parent program. */
export function registerMemory(parent: Command, deps: MemoryCliDeps = {}): Command {
  const r = buildDeps(deps);
  const m = parent.command('memory').description('Memory migration + maintenance (G.6 + G.7)');

  m.command('import-auto')
    .description('Bulk-import Claude Code auto-memory files into loop-engine')
    .option('--dry-run', 'preview without writing', false)
    .option('--project <path>', 'override which project dir to read (default: cwd)')
    .option('--auto-memory-root <path>', 'override ~/.claude/projects/ root')
    .action((opts: ImportAutoOpts) => actImportAuto(r, opts));

  m.command('snapshot-auto')
    .description('Incremental catch-up: re-import auto-memory files modified since last snapshot')
    .option('--project <path>', 'override which project dir to read (default: cwd)')
    .option('--auto-memory-root <path>', 'override ~/.claude/projects/ root')
    .action((opts: SnapshotAutoOpts) => actSnapshotAuto(r, opts));

  return m;
}
