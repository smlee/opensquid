/**
 * Codex MCP registry writer (T-codex-e2e-setup CE.1/CE.2) — the TOML sibling of
 * `mcp-writer.ts`'s JSON `~/.claude.json` writer.
 *
 * Registers opensquid's two MCP servers into Codex's `~/.codex/config.toml`
 * (honoring `$CODEX_HOME`) as `[mcp_servers.<id>]` tables so a Codex lap set up
 * THROUGH opensquid can reach `workgraph_get` (ralph_template.ts) — instead of
 * running item-blind. The `opensquid` server is marked `required = true` (CE.2:
 * the config-reference semantic "fail startup/resume if this enabled MCP server
 * cannot initialize" — so `codex exec` fails-loud, not item-blind); the
 * optional-telemetry `opensquid-chat` server is NOT required.
 *
 *   - `opensquid`       → `opensquid-mcp` (shipped bin) or `node <root>/dist/mcp/server.js`
 *   - `opensquid-chat`  → `opensquid-chat-bridge-mcp` or `node <root>/dist/mcp/chat-bridge-server.js`
 *
 * The two servers' command/args are NOT re-defined here — `buildDesiredEntries`
 * (mcp-writer.ts) is the single source of truth; this writer merely TRANSLATES
 * that shape into Codex's TOML entry (dropping the JSON `type: 'stdio'` — Codex
 * infers stdio from `command` — and carrying the `'@opensquid'` ownership
 * marker + CE.2's `required`). Both writers therefore describe ONE definition.
 *
 * Idempotency + preservation: a parse → merge-our-two-tables → stringify round
 * trip via `smol-toml` (TOML 1.0, ESM). Re-runs OVERWRITE the two opensquid
 * tables by key and preserve every unrelated table (`[features]`, foreign
 * `[mcp_servers.*]`, model settings) verbatim. A pre-existing UNFENCED manual
 * `[mcp_servers.opensquid]` table is correctly REPLACED (a real parser handles
 * the table redefinition a naive fence-append could not — TOML forbids
 * duplicate tables). A `.bak` snapshot is written BEFORE any mutation: it is the
 * recovery path for the one cost of the round trip — `parse → stringify` drops
 * the user's comments and re-formats. A comment-preserving surgical merge is
 * deliberately NOT attempted: the unfenced-manual-table case makes it unsafe.
 *
 * Engine-vocabulary discipline: this is the ONLY file that names Codex's
 * `config.toml` `[mcp_servers.<id>]` TOML layout — the CLI surface in
 * `../cli/mcp.ts` stays harness-agnostic, exactly as `mcp-writer.ts` states for
 * `~/.claude.json`.
 *
 * Imports from: node:fs, smol-toml, ./mcp-writer.js (buildDesiredEntries SSOT).
 * Imported by: src/setup/cli/mcp.ts.
 */

import { promises as fs } from 'node:fs';

import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

import { buildDesiredEntries, type McpWriteResult } from './mcp-writer.js';

/** One Codex `[mcp_servers.<id>]` table. Foreign keys (startup_timeout_sec,
 *  tool_timeout_sec, …) round-trip verbatim via the index signature. */
export interface CodexMcpServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  required?: boolean; // CE.2 — mcp_servers.opensquid.required = true (fail-loud, not item-blind)
  '@opensquid'?: boolean; // ownership marker — same contract as the JSON writer's marker
  [k: string]: unknown;
}

/** A parsed `config.toml`. Every non-`mcp_servers` top-level key ([features],
 *  model settings, …) is preserved verbatim via the index signature. */
export interface CodexConfig {
  mcp_servers?: Record<string, CodexMcpServerEntry>;
  [k: string]: unknown;
}

/**
 * Translate the JSON desired-entries SSOT (`buildDesiredEntries`) into the two
 * Codex TOML entries. Module-private: the servers are DEFINED once in
 * `buildDesiredEntries`; only the translation (drop `type`, drop empty `env`,
 * add the marker + CE.2's `required` on `opensquid` only) lives here. The
 * `required`-present/absent shape is asserted through the WRITTEN TOML (CE.4).
 */
function buildCodexDesiredEntries(
  root?: string,
): Record<'opensquid' | 'opensquid-chat', CodexMcpServerEntry> {
  const j = buildDesiredEntries(root); // SSOT for command/args (shipped bins or node <root>/dist/...)
  const toEntry = (e: {
    command?: string;
    args?: string[];
    env?: Record<string, string>;
  }): CodexMcpServerEntry => ({
    // omit `command` when undefined (exactOptionalPropertyTypes: `command?: string` ≠ `string | undefined`);
    // buildDesiredEntries always sets it, so this is defensive.
    ...(e.command !== undefined ? { command: e.command } : {}),
    args: e.args ?? [],
    // env is locked empty (project/session ride the cwd chain — anchor.ts) → omit the [.env] sub-table.
    // The projection SUPPORTS one: a future non-empty desired `env` would emit `[mcp_servers.<id>.env]`.
    ...(e.env && Object.keys(e.env).length > 0 ? { env: e.env } : {}),
    '@opensquid': true,
  });
  return {
    // required=true on opensquid ONLY — the lap needs `workgraph_get`; a failed opensquid init must fail-loud.
    opensquid: { ...toEntry(j.opensquid), required: true },
    // opensquid-chat is optional telemetry — its init failure must NOT fail-loud the lap → NOT required.
    'opensquid-chat': toEntry(j['opensquid-chat']),
  };
}

/**
 * Pure projection. Disk-untouched — used by both the writer and `--dry-run`.
 * Overwrites the two opensquid tables by KEY (idempotent; the `'@opensquid'`
 * marker identifies them for future detection/doctor), preserves every
 * unrelated table.
 */
export function projectCodexMcp(
  input: CodexConfig,
  root?: string,
): { output: CodexConfig; added: string[]; replaced: string[]; preserved: number } {
  const output = JSON.parse(JSON.stringify(input)) as CodexConfig;
  output.mcp_servers ??= {};
  const desired = buildCodexDesiredEntries(root);
  const added: string[] = [];
  const replaced: string[] = [];
  for (const [name, entry] of Object.entries(desired)) {
    (output.mcp_servers[name] === undefined ? added : replaced).push(name);
    output.mcp_servers[name] = entry;
  }
  const preserved = Object.keys(output.mcp_servers).filter(
    (k) => k !== 'opensquid' && k !== 'opensquid-chat',
  ).length;
  return { output, added, replaced, preserved };
}

/** ENOENT → `{}` (first-run). All other errors propagate (mirror
 *  `readClaudeUserConfig`). Parses TOML via `smol-toml`. */
export async function readCodexConfig(path: string): Promise<CodexConfig> {
  try {
    return parseToml(await fs.readFile(path, 'utf-8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw e;
  }
}

/**
 * Write opensquid's two MCP entries into `config.toml` (path injected — tests
 * pass a tmpdir path, the CLI passes `$CODEX_HOME/config.toml`). A `.bak`
 * snapshot is written BEFORE the mutation. Returns the SAME `McpWriteResult`
 * shape as `writeOpensquidMcp` — ONE contract across both writers.
 */
export async function writeCodexMcp(configPath: string, root?: string): Promise<McpWriteResult> {
  const input = await readCodexConfig(configPath);
  const backupPath = `${configPath}.bak`;
  await fs.writeFile(backupPath, stringifyToml(input)); // .bak mitigates the round-trip comment/format loss
  const { output, added, replaced, preserved } = projectCodexMcp(input, root);
  await fs.writeFile(configPath, stringifyToml(output));
  return { added, replaced, preserved, backupPath };
}
