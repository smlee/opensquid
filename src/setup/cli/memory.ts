/**
 * `opensquid memory` CLI verb group (G.6 + G.7).
 *
 * Verbs:
 *
 *   import-auto    — bulk-imports Claude Code auto-memory files from
 *                    `~/.claude/projects/<encoded-path>/memory/` into the
 *                    loop-engine via direct `engine.memoryCreate` RPC.
 *                    Dedupe by frontmatter `name` (round-tripped through
 *                    `origin.host`).
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
 * formatting + engine-client lifecycle (lazy singleton mirrored from
 * `mcp/server.ts`).
 *
 * Imports from: commander, node:os, node:path, ../../engine/client.js,
 *   ../../runtime/paths.js, ../migrate/auto_memory_importer.js,
 *   ../migrate/auto_memory_snapshot.js.
 * Imported by: src/cli.ts, src/setup/cli/memory.test.ts.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import { EngineClient } from '../../engine/client.js';
import { OPENSQUID_HOME } from '../../runtime/paths.js';
import {
  fetchExistingImportNames,
  importAutoMemoryDir,
  type ImportResult,
} from '../migrate/auto_memory_importer.js';
import { snapshotAuto } from '../migrate/auto_memory_snapshot.js';

import type { Command } from 'commander';

export interface MemoryCliDeps {
  /** Override engine client (tests inject a stub). */
  engineFactory?: () => EngineClient;
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
 * `/Users/slee/x` → `-Users-slee-x`). Non-path inputs are passed verbatim.
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
    `${prefix}Imported ${String(result.imported)}, skipped ${String(result.skipped)}, errors ${String(result.errors.length)} (from ${dir})\n`,
  );
  for (const err of result.errors) {
    deps.stderr(`  error: ${err.path}: ${err.reason}\n`);
  }
  if (result.errors.length > 0) process.exitCode = 1;
}

async function actImportAuto(deps: Required<MemoryCliDeps>, opts: ImportAutoOpts): Promise<void> {
  const dir = await resolveDir(deps, opts, 'import-auto');
  if (dir === null) return;
  const engine = deps.engineFactory();
  try {
    const existingNames = await fetchExistingImportNames(engine);
    const result = await importAutoMemoryDir(dir, engine, {
      dryRun: opts.dryRun,
      existingNames,
    });
    reportResult(deps, result, opts.dryRun ? '[dry-run] ' : '', dir);
  } finally {
    await engine.close();
  }
}

async function actSnapshotAuto(
  deps: Required<MemoryCliDeps>,
  opts: SnapshotAutoOpts,
): Promise<void> {
  const dir = await resolveDir(deps, opts, 'snapshot-auto');
  if (dir === null) return;
  const engine = deps.engineFactory();
  try {
    const result = await snapshotAuto(dir, deps.opensquidHome(), engine);
    reportResult(deps, result, 'Snapshot: ', dir);
  } finally {
    await engine.close();
  }
}

function buildDeps(d: MemoryCliDeps): Required<MemoryCliDeps> {
  return {
    engineFactory: d.engineFactory ?? ((): EngineClient => new EngineClient()),
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
