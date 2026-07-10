/**
 * Host resolution for `setup wizard mcp` multi-host registration (Track MMH.1).
 *
 * The opensquid MCP writer (`mcp-writer.ts`) is host-generic — it merges the
 * opensquid entries into any `{ "mcpServers": { … } }` JSON file and preserves
 * every other key. The ONLY host-specific knowledge is each host's config-file
 * path, which differs per platform. This module owns that mapping + the
 * `--hosts` flag parsing. Everything here is pure (no I/O) so it's trivially
 * testable across platforms.
 *
 * Hosts in the "Claude ecosystem" on one machine each read a SEPARATE config —
 * registering one does not cover another (the 2026-05-27 "Desktop wasn't aware
 * of opensquid" gap). See the reference memory on per-host MCP config files.
 *
 * Imported by: src/setup/cli/mcp.ts.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

export type HostId = 'claude-code' | 'claude-desktop' | 'cursor' | 'codex';

export const ALL_HOSTS: readonly HostId[] = ['claude-code', 'claude-desktop', 'cursor', 'codex'];

export interface HostTarget {
  id: HostId;
  /** Absolute config-file path for this host on this platform. */
  configPath: string;
  /** Human label for output + restart reminders. */
  label: string;
  /** Whether the app must be restarted to load the servers (binds MCP at start). */
  needsRestart: boolean;
}

export interface HostResolveEnv {
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
}

/** Default resolution context from the live process. */
export function liveResolveEnv(): HostResolveEnv {
  return { platform: process.platform, home: homedir(), env: process.env };
}

/**
 * Codex's config/auth dir: `$CODEX_HOME`, else `~/.codex` (Codex docs). This is
 * the HOST-path half of the two-readers-of-one-source lock — the AUTH-path half
 * lives in `codex_lap_harness.ts` (the same 1-liner, read independently to keep
 * the setup-writer / lap-preflight scopes disjoint; the env var is the single
 * store, both merely read it). Pure.
 */
export function resolveCodexHome(e: HostResolveEnv): string {
  return e.env.CODEX_HOME ?? join(e.home, '.codex');
}

/** Resolve a host id to its per-platform config path. Pure. */
export function resolveHost(id: HostId, e: HostResolveEnv): HostTarget {
  switch (id) {
    case 'claude-code':
      return {
        id,
        configPath: join(e.home, '.claude.json'),
        label: 'Claude Code',
        needsRestart: false,
      };
    case 'claude-desktop': {
      let dir: string;
      if (e.platform === 'darwin') {
        dir = join(e.home, 'Library', 'Application Support', 'Claude');
      } else if (e.platform === 'win32') {
        dir = join(e.env.APPDATA ?? join(e.home, 'AppData', 'Roaming'), 'Claude');
      } else {
        dir = join(e.env.XDG_CONFIG_HOME ?? join(e.home, '.config'), 'Claude');
      }
      return {
        id,
        configPath: join(dir, 'claude_desktop_config.json'),
        label: 'Claude Desktop',
        needsRestart: true,
      };
    }
    case 'cursor':
      return {
        id,
        configPath: join(e.home, '.cursor', 'mcp.json'),
        label: 'Cursor',
        needsRestart: true,
      };
    case 'codex':
      return {
        id,
        configPath: join(resolveCodexHome(e), 'config.toml'),
        label: 'Codex',
        needsRestart: true,
      };
  }
}

/**
 * Parse the `--hosts` flag value. Default (undefined/empty) = claude-code ONLY
 * (D1: no behavior change for existing callers). `all` = every host. A
 * comma-list selects by id; unknown ids are dropped with a warn (error only
 * surfaces later if NO valid host remains). De-duplicates, preserves order.
 */
export function parseHosts(raw: string | undefined, warn: (m: string) => void): HostId[] {
  if (raw === undefined || raw.trim() === '') return ['claude-code'];
  if (raw.trim() === 'all') return [...ALL_HOSTS];
  const out: HostId[] = [];
  for (const tok of raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')) {
    if ((ALL_HOSTS as readonly string[]).includes(tok)) {
      if (!out.includes(tok as HostId)) out.push(tok as HostId);
    } else {
      warn(`setup wizard mcp: unknown host '${tok}' — skipping (valid: ${ALL_HOSTS.join(', ')})`);
    }
  }
  return out;
}
