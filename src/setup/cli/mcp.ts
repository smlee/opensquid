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

import { stat } from 'node:fs/promises';

import {
  buildDesiredEntries,
  projectOpensquidMcp,
  readClaudeUserConfig,
  writeOpensquidMcp,
  type McpServerEntry,
  type McpWriteResult,
} from '../wizard/mcp-writer.js';
import {
  projectCodexMcp,
  readCodexConfig,
  writeCodexMcp,
  type CodexConfig,
} from '../wizard/codex-mcp-writer.js';
import { writePiMcp } from '../wizard/pi-mcp-writer.js';
import {
  defaultPiExpectedConfig,
  projectPiMcpConfig,
  readPiMcpConfig,
  type PiMcpConfigFile,
} from '../../integrations/pi/mcp_config.js';
import {
  ALL_HOSTS,
  parseHosts,
  resolveHost,
  type HostId,
  type HostResolveEnv,
} from '../wizard/mcp-hosts.js';

import type { Command } from 'commander';

export interface McpCliFlags {
  dryRun?: boolean;
  opensquidRoot?: string;
  detectProjectCleanup?: boolean;
  /** Comma-list of host ids or `all`; default (undefined) = claude-code only. */
  hosts?: string;
}

export interface McpCliDeps {
  writer?: (path: string, root?: string) => Promise<McpWriteResult>;
  reader?: (path: string) => Promise<unknown>;
  /** Codex TOML writer (per-host dispatch; default `writeCodexMcp`). */
  codexWriter?: (path: string, root?: string) => Promise<McpWriteResult>;
  /** Codex TOML reader for the dry-run projection (default `readCodexConfig` —
   *  the JSON reader would throw on an existing `config.toml`). */
  codexReader?: (path: string) => Promise<CodexConfig>;
  /** Pi JSON writer (default `writePiMcp`). */
  piWriter?: (path: string, root?: string) => Promise<McpWriteResult>;
  /** Pi JSON reader for dry-run projection (default `readPiMcpConfig`). */
  piReader?: (path: string) => Promise<PiMcpConfigFile>;
  cwd?: () => string;
  home?: () => string;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  isTty?: () => boolean;
  /** Does this path exist? (used to skip a host whose app dir is absent). */
  dirExists?: (path: string) => Promise<boolean>;
  /** Platform for host-path resolution (injected for deterministic tests). */
  platform?: () => NodeJS.Platform;
}

interface ResolvedDeps {
  writer: (path: string, root?: string) => Promise<McpWriteResult>;
  reader: (path: string) => Promise<unknown>;
  codexWriter: (path: string, root?: string) => Promise<McpWriteResult>;
  codexReader: (path: string) => Promise<CodexConfig>;
  piWriter: (path: string, root?: string) => Promise<McpWriteResult>;
  piReader: (path: string) => Promise<PiMcpConfigFile>;
  cwd: () => string;
  home: () => string;
  out: (s: string) => void;
  err: (s: string) => void;
  isTty: () => boolean;
  dirExists: (path: string) => Promise<boolean>;
  platform: () => NodeJS.Platform;
}

function buildDeps(deps: McpCliDeps): ResolvedDeps {
  return {
    writer: deps.writer ?? writeOpensquidMcp,
    reader: deps.reader ?? readClaudeUserConfig,
    codexWriter: deps.codexWriter ?? writeCodexMcp,
    codexReader: deps.codexReader ?? readCodexConfig,
    piWriter:
      deps.piWriter ??
      ((path, root) =>
        writePiMcp({
          cli: 'pi',
          cwd: process.cwd(),
          env: { ...process.env, PI_CODING_AGENT_DIR: dirname(path) },
          ...(root === undefined ? {} : { opensquidRoot: root }),
        })),
    piReader: deps.piReader ?? readPiMcpConfig,
    cwd: deps.cwd ?? ((): string => process.cwd()),
    home: deps.home ?? homedir,
    out: deps.stdout ?? ((s): void => void process.stdout.write(s)),
    err: deps.stderr ?? ((s): void => void process.stderr.write(s)),
    isTty: deps.isTty ?? ((): boolean => process.stdout.isTTY === true),
    dirExists:
      deps.dirExists ??
      ((p: string): Promise<boolean> =>
        stat(p)
          .then(() => true)
          .catch(() => false)),
    platform: deps.platform ?? ((): NodeJS.Platform => process.platform),
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
  // wg-798ce60dbb13: NO repo root required — register the shipped bins by default
  // (buildDesiredEntries with no root). `--opensquid-root` is an OPTIONAL override (PATH-stripped
  // hosts) that forces the legacy `node <root>/dist/...` form. undefined ⇒ bins.
  const root = flags.opensquidRoot;
  // D1: default = claude-code only; opt into others via --hosts.
  const hostIds = parseHosts(flags.hosts, r.err);
  if (hostIds.length === 0) {
    r.err(`opensquid setup wizard mcp: no valid hosts selected (valid: ${ALL_HOSTS.join(', ')})\n`);
    process.exitCode = 1;
    return;
  }
  const env: HostResolveEnv = { platform: r.platform(), home: r.home(), env: process.env };

  // D2: skip a host whose app dir is absent (don't fabricate its tree).
  // Claude Code's dir is the home dir — always present.
  const hostPresent = async (id: HostId, configPath: string): Promise<boolean> =>
    id === 'claude-code' || id === 'pi' || (await r.dirExists(dirname(configPath)));

  if (flags.dryRun === true) {
    r.out('opensquid setup wizard mcp — DRY RUN (no files written)\n');
    for (const id of hostIds) {
      const t = resolveHost(id, env);
      if (!(await hostPresent(id, t.configPath))) {
        r.out(`  ${t.label}: not detected (${dirname(t.configPath)}) — would skip\n`);
        continue;
      }
      // Per-host projection: codex reads/parses TOML; Pi projects its dedicated JSON; every other host is JSON.
      const { added, replaced, preserved } =
        t.id === 'codex'
          ? projectCodexMcp(await r.codexReader(t.configPath), root)
          : t.id === 'pi'
            ? projectPiMcpConfig(
                await r.piReader(t.configPath),
                defaultPiExpectedConfig({
                  cwd: r.cwd(),
                  env: { ...process.env, PI_CODING_AGENT_DIR: dirname(t.configPath) },
                  ...(root === undefined ? {} : { opensquidRoot: root }),
                }),
              )
            : projectOpensquidMcp(
                (await r.reader(t.configPath)) as Parameters<typeof projectOpensquidMcp>[0],
                root,
              );
      r.out(
        `  ${t.label} (${t.configPath}): would add [${added.join(', ')}], replace [${replaced.join(
          ', ',
        )}], preserve ${String(preserved)} unrelated mcpServer(s)\n`,
      );
    }
    const desired = buildDesiredEntries(root);
    const cmdline = (e: McpServerEntry): string =>
      `${e.command ?? ''} ${(e.args ?? []).join(' ')}`.trim();
    r.out(`  opensquid       → ${cmdline(desired.opensquid)}\n`);
    r.out(`  opensquid-chat  → ${cmdline(desired['opensquid-chat'])}\n`);
  } else {
    r.out('opensquid setup wizard mcp — writing entries\n');
    for (const id of hostIds) {
      const t = resolveHost(id, env);
      if (!(await hostPresent(id, t.configPath))) {
        r.out(`  ${t.label}: not detected (${dirname(t.configPath)}) — skipped\n`);
        continue;
      }
      // Per-host writer: codex → TOML config.toml; Pi → dedicated JSON; every other host → JSON.
      const writer = t.id === 'codex' ? r.codexWriter : t.id === 'pi' ? r.piWriter : r.writer;
      const result = await writer(t.configPath, root);
      r.out(
        `  ${t.label} (${t.configPath}): added [${result.added.join(
          ', ',
        )}], replaced [${result.replaced.join(', ')}], preserved ${String(
          result.preserved,
        )} unrelated mcpServer(s) (backup: ${result.backupPath})\n`,
      );
      if (t.needsRestart) r.out(`  ↳ restart ${t.label} to load the servers.\n`);
    }
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
    .description(
      'Register opensquid MCP servers into supported hosts — Claude Code/Desktop, Cursor, Codex, Pi (default: Claude Code)',
    )
    .option('--dry-run', 'preview the projected changes without writing any file', false)
    .option('--opensquid-root <path>', 'override the auto-detected opensquid repo root')
    .option('--no-detect-project-cleanup', 'skip the project-level .mcp.json cleanup advisory')
    .option(
      '--hosts <list>',
      'comma-list of hosts (claude-code, claude-desktop, cursor, codex, pi) or "all"; default: claude-code',
    )
    .action(async (flags: McpCliFlags) => {
      await runMcpWizard(flags, deps);
    });
  return wizard;
}
