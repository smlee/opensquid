/**
 * agent_bridge — MCP config materialization helper (WAB-SUB.2, 0.5.106).
 *
 * Spec: WAB-SUB.2 task — "Pass MCP config path through to subscription-mode
 * opts so spawned claude can find opensquid's tools".
 *
 * Responsibility:
 *   When the agent-bridge daemon runs in subscription mode, the spawned
 *   `claude --print` subprocess needs to know how to reach opensquid's MCP
 *   servers (`opensquid-mcp` read-only inspection + `opensquid-chat-bridge-mcp`
 *   mutation surface). We materialize a JSON file at a known path with the
 *   stdio-transport entries the host expects (`mcpServers: { name: { command,
 *   args, env } }` shape — matches `.mcp.json` / `claude_desktop_config.json`
 *   convention).
 *
 * Default path: `${OPENSQUID_HOME()}/agent-bridge/mcp-config.json`. The
 * file is OWNED by the daemon — overwritten on every start so a stale
 * config from a previous opensquid install never silently misroutes the
 * subscription subprocess. Users who want a custom config can point
 * `OPENSQUID_AGENT_BRIDGE_MCP_CONFIG` at their own file; the materializer
 * skips writing in that case (custom config is the user's responsibility).
 *
 * Why JSON not YAML: the MCP host convention (Anthropic + others) reads
 * JSON. We emit what claude --mcp-config will accept verbatim.
 *
 * Why an opt-in helper not always-on: keeps api-mode daemons from paying
 * the I/O cost for nothing; keeps test fixtures clean.
 *
 * Tool enumeration: we ship BOTH `opensquid-mcp` (read-only) and
 * `opensquid-chat-bridge-mcp` (chat_send + chat_poll_inbox) so the spawned
 * agent has full read+chat surface. Both bins live under `node_modules/.bin/`
 * after `pnpm add opensquid`; the resolver below tries node_modules then
 * falls back to PATH lookup so a globally-installed opensquid works too.
 *
 * Imports from: node:fs/promises, node:path, ../paths.js.
 * Imported by: ./daemon.ts (subscription-mode start path),
 *   ./mcp_config.test.ts.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { OPENSQUID_HOME } from '../paths.js';

// ---------------------------------------------------------------------------
// Public types — match the .mcp.json / claude config shape.
// ---------------------------------------------------------------------------

export interface McpServerEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpConfigDocument {
  mcpServers: Record<string, McpServerEntry>;
}

export interface MaterializeMcpConfigOptions {
  /** Override target path (tests + custom-config users). */
  targetPath?: string;
  /** Override the OPENSQUID_HOME base (tests). */
  daemonHome?: string;
  /** Override env passthrough (e.g. forward OPENSQUID_HOME to the child). */
  envPassthrough?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Default path
// ---------------------------------------------------------------------------

/** Default location for the agent-bridge MCP config. */
export const defaultMcpConfigPath = (home?: string): string =>
  join(home ?? OPENSQUID_HOME(), 'agent-bridge', 'mcp-config.json');

// ---------------------------------------------------------------------------
// Default servers — read-only opensquid-mcp + chat-bridge mutation surface.
//
// Both bins are exposed via package.json `bin` (`opensquid-mcp` +
// `opensquid-chat-bridge-mcp`). We rely on PATH resolution by default —
// when opensquid is installed (npm/pnpm), the bins land in node_modules/.bin
// (project-local) or the global bin dir. Either way, `command: 'opensquid-mcp'`
// resolves correctly from a spawned subprocess that inherits PATH from the
// daemon's environment.
// ---------------------------------------------------------------------------

export function defaultMcpServers(
  env: Record<string, string> = {},
): Record<string, McpServerEntry> {
  return {
    opensquid: {
      command: 'opensquid-mcp',
      ...(Object.keys(env).length > 0 ? { env } : {}),
    },
    'opensquid-chat': {
      command: 'opensquid-chat-bridge-mcp',
      ...(Object.keys(env).length > 0 ? { env } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// materializeDefaultMcpConfig — write the default doc to disk.
//
// Returns the absolute path to the written file. Idempotent — overwrites
// every call so a fresh daemon start always has a known-good doc. Creates
// parent dirs as needed.
//
// Caller (daemon.ts) decides WHEN to call (only on subscription-mode start
// when no override path is supplied).
// ---------------------------------------------------------------------------

export async function materializeDefaultMcpConfig(
  opts: MaterializeMcpConfigOptions = {},
): Promise<string> {
  const target = opts.targetPath ?? defaultMcpConfigPath(opts.daemonHome);
  const dir = target.slice(0, target.lastIndexOf('/'));
  if (dir.length > 0) await mkdir(dir, { recursive: true });
  const doc: McpConfigDocument = {
    mcpServers: defaultMcpServers(opts.envPassthrough ?? {}),
  };
  await writeFile(target, JSON.stringify(doc, null, 2), 'utf8');
  return target;
}

// ---------------------------------------------------------------------------
// resolveMcpConfigPath — env-override wins, else materialize default.
//
// Used by the daemon's subscription-mode start path. Three cases:
//   1. `OPENSQUID_AGENT_BRIDGE_MCP_CONFIG` set → return that path verbatim
//      (user owns the file; we don't touch it).
//   2. `opts.explicitPath` set (test injection) → return that, no write.
//   3. Otherwise → materializeDefaultMcpConfig() and return the path.
//
// The env override is the documented escape hatch for users with custom
// MCP server arrangements (extra servers, alternate transports).
// ---------------------------------------------------------------------------

export interface ResolveMcpConfigOptions {
  /** Caller-supplied path override (skips materialization). */
  explicitPath?: string;
  /** Override env source (tests). Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Override daemon home (tests). */
  daemonHome?: string;
}

export async function resolveMcpConfigPath(opts: ResolveMcpConfigOptions = {}): Promise<string> {
  const env = opts.env ?? process.env;
  const fromEnv = env.OPENSQUID_AGENT_BRIDGE_MCP_CONFIG;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  if (opts.explicitPath !== undefined && opts.explicitPath.length > 0) {
    return opts.explicitPath;
  }
  return materializeDefaultMcpConfig({
    ...(opts.daemonHome !== undefined ? { daemonHome: opts.daemonHome } : {}),
  });
}
