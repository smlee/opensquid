/**
 * Idempotent writer for Claude Code's USER-level MCP server registry (G.8).
 *
 * Writes two entries into `~/.claude.json` (or whatever path the caller
 * supplies — tests inject a tmpdir path):
 *
 *   - `opensquid`       → `node <root>/dist/mcp/server.js`
 *   - `opensquid-chat`  → `node <root>/dist/mcp/chat-bridge-server.js`
 *
 * Both entries are tagged `'@opensquid': true` — the marker contract is the
 * SAME shape as G.1's `settings-writer.ts` hook entries, which lets future
 * wizard passes (and `opensquid doctor`) distinguish entries this writer
 * owns from third-party MCP entries (claude.ai-Figma, Notion, Vercel, etc.).
 *
 * Every non-`mcpServers` key in `~/.claude.json` is preserved verbatim via
 * spread round-trip — that file holds tons of per-project state in the
 * real-world install and MUST NOT get clobbered.
 *
 * Legacy detection: an existing `opensquid` entry pointing at the broken
 * `node <abs>/opensquid/dist/index.js` shape (which silently no-ops — see
 * memory `opensquid-dist-index-entrypoint-gotcha`) is replaced with the
 * correct `dist/mcp/server.js` path. Detection trips on (a) the
 * `'@opensquid': true` marker OR (b) command='node' AND any arg ending in
 * `dist/index.js` under an `opensquid` path segment — same conservative
 * stance G.1's `LEGACY_OPENSQUID_PATTERN` takes.
 *
 * A `.bak` snapshot is written BEFORE any mutation. The marker contract is
 * the first line of defense; .bak is the last.
 *
 * Engine-vocabulary discipline: this module is the ONLY G.8 file that
 * names Claude Code's `~/.claude.json` layout. The CLI surface in
 * `../cli/mcp.ts` is harness-agnostic input/output plumbing only.
 *
 * Imported by: src/setup/cli/mcp.ts.
 */

import { promises as fs } from 'node:fs';

// Loose entry shape — round-trip `unknown` fields verbatim so third-party
// MCP schema additions (e.g. Vercel's `headers` block) survive untouched.
export interface McpServerEntry {
  type?: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  '@opensquid'?: boolean;
  [k: string]: unknown;
}

interface ClaudeUserConfig {
  mcpServers?: Record<string, McpServerEntry>;
  [k: string]: unknown;
}

// Legacy detector — narrow on purpose. We want to recognise the broken
// `node /abs/opensquid/dist/index.js` shape ONLY when it lives under the
// `opensquid` MCP key (the only key this writer manages). Third-party
// entries with unrelated commands never trip this.
export function isLegacyOpensquidEntry(entry: McpServerEntry | undefined): boolean {
  if (entry === undefined) return false;
  if (entry['@opensquid'] === true) return true;
  if (entry.command !== 'node') return false;
  const args = entry.args ?? [];
  return args.some((a) => typeof a === 'string' && /opensquid\/.*dist\/index\.js$/.test(a));
}

export interface DesiredEntries {
  opensquid: McpServerEntry;
  'opensquid-chat': McpServerEntry;
}

export function buildDesiredEntries(opensquidRepoRoot: string): DesiredEntries {
  return {
    opensquid: {
      type: 'stdio',
      command: 'node',
      args: [`${opensquidRepoRoot}/dist/mcp/server.js`],
      env: {},
      '@opensquid': true,
    },
    'opensquid-chat': {
      type: 'stdio',
      command: 'node',
      args: [`${opensquidRepoRoot}/dist/mcp/chat-bridge-server.js`],
      env: {},
      '@opensquid': true,
    },
  };
}

export interface McpWriteResult {
  /** Entry names added fresh (no prior entry under that key). */
  added: string[];
  /** Entry names replaced (prior entry existed — opensquid-owned or legacy). */
  replaced: string[];
  /** Number of unrelated mcpServers entries preserved verbatim. */
  preserved: number;
  /** Path to the `.bak` snapshot. */
  backupPath: string;
}

/** Pure projection. Disk-untouched. Used by both writer and `--dry-run`. */
export function projectOpensquidMcp(
  input: ClaudeUserConfig,
  opensquidRepoRoot: string,
): { output: ClaudeUserConfig; added: string[]; replaced: string[]; preserved: number } {
  const output = JSON.parse(JSON.stringify(input)) as ClaudeUserConfig;
  output.mcpServers ??= {};
  const desired = buildDesiredEntries(opensquidRepoRoot);
  const added: string[] = [];
  const replaced: string[] = [];

  for (const [name, entry] of Object.entries(desired) as [keyof DesiredEntries, McpServerEntry][]) {
    const existing = output.mcpServers[name];
    if (existing === undefined) added.push(name);
    else replaced.push(name);
    output.mcpServers[name] = entry;
  }

  // Anything in mcpServers that is NOT one of the two opensquid keys is
  // preserved verbatim (it was already there before the spread+overwrite).
  const preserved = Object.keys(output.mcpServers).filter(
    (k) => k !== 'opensquid' && k !== 'opensquid-chat',
  ).length;

  return { output, added, replaced, preserved };
}

/**
 * Write opensquid's two MCP entries into `~/.claude.json` (path injected).
 * Creates a `.bak` snapshot (`{}` when the file did not exist). 2-space
 * JSON indentation matches Claude Code's own format, so `diff <file>.bak
 * <file>` highlights only the mcpServers delta.
 */
export async function writeOpensquidMcp(
  claudeConfigPath: string,
  opensquidRepoRoot: string,
): Promise<McpWriteResult> {
  const input = await readClaudeUserConfig(claudeConfigPath);
  const backupPath = `${claudeConfigPath}.bak`;
  await fs.writeFile(backupPath, JSON.stringify(input, null, 2));

  const { output, added, replaced, preserved } = projectOpensquidMcp(input, opensquidRepoRoot);
  await fs.writeFile(claudeConfigPath, JSON.stringify(output, null, 2));
  return { added, replaced, preserved, backupPath };
}

/** ENOENT → `{}` (first-run case). All other errors propagate. */
export async function readClaudeUserConfig(path: string): Promise<ClaudeUserConfig> {
  try {
    const raw = await fs.readFile(path, 'utf-8');
    return JSON.parse(raw) as ClaudeUserConfig;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw e;
  }
}
