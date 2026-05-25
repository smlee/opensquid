/**
 * `opensquid setup wizard mcp` — register opensquid MCP servers at the
 * USER level (`~/.claude.json` mcpServers) so the central brain is
 * reachable from EVERY Claude Code project automatically, without per-
 * project `.mcp.json` setup.
 *
 * Companion to G.1's `setup wizard hooks` — same shape, same `@opensquid`
 * marker contract, same `.bak` semantics. See `mcp-writer.ts` header for
 * the file-level details.
 *
 * Flow:
 *   1. Resolve `opensquidRepoRoot` (cwd-walk for the opensquid package.json,
 *      or explicit `--opensquid-root <path>` override).
 *   2. Dry-run: project the change, print counts, exit. No mutation.
 *   3. Commit: write `~/.claude.json` + `.bak`, print counts.
 *   4. Project cleanup advisory: if `<cwd>/.mcp.json` exists with opensquid
 *      entries, print them with offer-to-remove guidance (we do NOT auto-
 *      remove in this task; doing so is a follow-up). For non-TTY, default
 *      to leaving them alone with a stderr note. Suppress entirely with
 *      `--no-detect-project-cleanup`.
 *
 * Flags:
 *   --dry-run                          Preview without writing.
 *   --opensquid-root <path>            Override auto-detected repo root.
 *   --no-detect-project-cleanup        Skip the project `.mcp.json` advisory.
 *
 * Imports from: commander, node:fs, node:os, node:path, ../wizard/mcp-writer.
 * Imported by: src/cli.ts (via `registerSetupWizardMcp`).
 */

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import {
  buildDesiredEntries,
  projectOpensquidMcp,
  readClaudeUserConfig,
  writeOpensquidMcp,
  type McpWriteResult,
} from '../wizard/mcp-writer.js';

import type { Command } from 'commander';

export interface McpCliFlags {
  dryRun?: boolean;
  opensquidRoot?: string;
  detectProjectCleanup?: boolean;
}

export interface McpCliDeps {
  writer?: (path: string, root: string) => Promise<McpWriteResult>;
  reader?: (path: string) => Promise<unknown>;
  cwd?: () => string;
  home?: () => string;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  isTty?: () => boolean;
}

interface ResolvedDeps {
  writer: (path: string, root: string) => Promise<McpWriteResult>;
  reader: (path: string) => Promise<unknown>;
  cwd: () => string;
  home: () => string;
  out: (s: string) => void;
  err: (s: string) => void;
  isTty: () => boolean;
}

function buildDeps(deps: McpCliDeps): ResolvedDeps {
  return {
    writer: deps.writer ?? writeOpensquidMcp,
    reader: deps.reader ?? readClaudeUserConfig,
    cwd: deps.cwd ?? ((): string => process.cwd()),
    home: deps.home ?? homedir,
    out: deps.stdout ?? ((s): void => void process.stdout.write(s)),
    err: deps.stderr ?? ((s): void => void process.stderr.write(s)),
    isTty: deps.isTty ?? ((): boolean => process.stdout.isTTY === true),
  };
}

/**
 * Walk up from `start` looking for a `package.json` whose `name` field
 * starts with `opensquid` (covers `opensquid` proper + future scoped
 * packages). Returns the directory containing that file, or null if not
 * found before reaching `/`.
 */
export async function detectOpensquidRoot(start: string): Promise<string | null> {
  let cur = resolve(start);
  for (;;) {
    const pkgPath = join(cur, 'package.json');
    try {
      const raw = await fs.readFile(pkgPath, 'utf-8');
      const pkg = JSON.parse(raw) as { name?: string };
      if (typeof pkg.name === 'string' && pkg.name.startsWith('opensquid')) return cur;
    } catch {
      /* keep walking */
    }
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

interface ProjectMcpJson {
  mcpServers?: Record<string, unknown>;
}

/** Report opensquid entries in `<cwd>/.mcp.json` (if any) — read-only. */
export async function detectProjectMcpCleanup(
  cwd: string,
): Promise<{ path: string; opensquidKeys: string[] } | null> {
  const path = join(cwd, '.mcp.json');
  try {
    const raw = await fs.readFile(path, 'utf-8');
    const cfg = JSON.parse(raw) as ProjectMcpJson;
    const keys = Object.keys(cfg.mcpServers ?? {}).filter(
      (k) => k === 'opensquid' || k === 'opensquid-chat',
    );
    if (keys.length === 0) return null;
    return { path, opensquidKeys: keys };
  } catch {
    return null;
  }
}

/** Pulled out of the commander action so tests can drive it directly. */
export async function runMcpWizard(flags: McpCliFlags, deps: McpCliDeps = {}): Promise<void> {
  const r = buildDeps(deps);
  const root = flags.opensquidRoot ?? (await detectOpensquidRoot(r.cwd()));
  if (root === null || root === undefined || root === '') {
    r.err(
      'opensquid setup wizard mcp: could not auto-detect opensquid repo root from cwd; pass --opensquid-root <path>\n',
    );
    process.exitCode = 1;
    return;
  }
  const userConfig = join(r.home(), '.claude.json');

  if (flags.dryRun === true) {
    r.out('opensquid setup wizard mcp — DRY RUN (no files written)\n');
    const input = (await r.reader(userConfig)) as Parameters<typeof projectOpensquidMcp>[0];
    const { added, replaced, preserved } = projectOpensquidMcp(input, root);
    r.out(
      `  ${userConfig}: would add [${added.join(', ')}], replace [${replaced.join(
        ', ',
      )}], preserve ${String(preserved)} unrelated mcpServer(s)\n`,
    );
    const desired = buildDesiredEntries(root);
    r.out(`  opensquid       → node ${desired.opensquid.args?.[0] ?? ''}\n`);
    r.out(`  opensquid-chat  → node ${desired['opensquid-chat'].args?.[0] ?? ''}\n`);
  } else {
    r.out('opensquid setup wizard mcp — writing entries\n');
    const result = await r.writer(userConfig, root);
    r.out(
      `  ${userConfig}: added [${result.added.join(', ')}], replaced [${result.replaced.join(
        ', ',
      )}], preserved ${String(result.preserved)} unrelated mcpServer(s) (backup: ${
        result.backupPath
      })\n`,
    );
  }

  if (flags.detectProjectCleanup !== false) {
    const advisory = await detectProjectMcpCleanup(r.cwd());
    if (advisory !== null) {
      r.out(`\nproject-level .mcp.json contains opensquid entries: ${advisory.path}\n`);
      r.out(`  keys: ${advisory.opensquidKeys.join(', ')}\n`);
      if (r.isTty()) {
        r.out(
          '  ↳ user-level registration is now authoritative; consider removing these to avoid double-loading.\n',
        );
      } else {
        r.err(
          'opensquid setup wizard mcp: non-TTY — leaving project-level .mcp.json untouched; re-run interactively to clean up.\n',
        );
      }
    }
  }
}

/**
 * Register the `wizard mcp` subcommand under the supplied `wizard` group.
 * Caller is responsible for creating the `wizard` group (G.1 does it via
 * `registerSetupWizard`); G.8 reuses that node by calling `.command('mcp')`
 * on the same `wizard` instance.
 */
export function registerSetupWizardMcp(wizard: Command, deps: McpCliDeps = {}): Command {
  wizard
    .command('mcp')
    .description('Register opensquid MCP servers at user level (~/.claude.json)')
    .option('--dry-run', 'preview the projected changes without writing any file', false)
    .option('--opensquid-root <path>', 'override the auto-detected opensquid repo root')
    .option('--no-detect-project-cleanup', 'skip the project-level .mcp.json cleanup advisory')
    .action(async (flags: McpCliFlags) => {
      await runMcpWizard(flags, deps);
    });
  return wizard;
}
