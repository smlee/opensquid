/**
 * Tests for host resolution + `--hosts` parsing (Track MMH.1).
 * Pure functions — no I/O, so platform is just an input.
 */

import { describe, expect, it } from 'vitest';

import {
  ALL_HOSTS,
  parseHosts,
  resolveCodexHome,
  resolveHost,
  type HostId,
  type HostResolveEnv,
} from './mcp-hosts.js';

const env = (over: Partial<HostResolveEnv> = {}): HostResolveEnv => ({
  platform: 'darwin',
  home: '/home/u',
  env: {},
  ...over,
});

describe('resolveHost', () => {
  it('resolves Claude Code to ~/.claude.json (no restart needed)', () => {
    const t = resolveHost('claude-code', env());
    expect(t.configPath).toBe('/home/u/.claude.json');
    expect(t.needsRestart).toBe(false);
  });

  it('resolves Claude Desktop on macOS', () => {
    const t = resolveHost('claude-desktop', env({ platform: 'darwin' }));
    expect(t.configPath).toBe(
      '/home/u/Library/Application Support/Claude/claude_desktop_config.json',
    );
    expect(t.needsRestart).toBe(true);
  });

  it('resolves Claude Desktop on Windows via APPDATA', () => {
    const t = resolveHost(
      'claude-desktop',
      env({ platform: 'win32', env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' } }),
    );
    expect(t.configPath).toContain('Claude');
    expect(t.configPath).toContain('claude_desktop_config.json');
    expect(t.configPath.startsWith('C:\\Users\\u\\AppData\\Roaming')).toBe(true);
  });

  it('falls back to ~/AppData/Roaming on Windows when APPDATA is unset', () => {
    const t = resolveHost('claude-desktop', env({ platform: 'win32', env: {} }));
    expect(t.configPath).toContain('AppData');
    expect(t.configPath).toContain('Roaming');
  });

  it('resolves Claude Desktop on Linux via XDG (default ~/.config)', () => {
    const t = resolveHost('claude-desktop', env({ platform: 'linux', env: {} }));
    expect(t.configPath).toBe('/home/u/.config/Claude/claude_desktop_config.json');
  });

  it('honors XDG_CONFIG_HOME on Linux', () => {
    const t = resolveHost(
      'claude-desktop',
      env({ platform: 'linux', env: { XDG_CONFIG_HOME: '/xdg' } }),
    );
    expect(t.configPath).toBe('/xdg/Claude/claude_desktop_config.json');
  });

  it('resolves Cursor to ~/.cursor/mcp.json (restart needed)', () => {
    const t = resolveHost('cursor', env());
    expect(t.configPath).toBe('/home/u/.cursor/mcp.json');
    expect(t.needsRestart).toBe(true);
  });

  it('resolves Codex to $CODEX_HOME/config.toml, defaulting to ~/.codex (CE.1)', () => {
    const dflt = resolveHost('codex', env());
    expect(dflt.configPath).toBe('/home/u/.codex/config.toml');
    expect(dflt.label).toBe('Codex');
    expect(dflt.needsRestart).toBe(true);
    const custom = resolveHost('codex', env({ env: { CODEX_HOME: '/custom' } }));
    expect(custom.configPath).toBe('/custom/config.toml');
  });

  it('resolves Pi to $PI_CODING_AGENT_DIR/mcp.json, defaulting to ~/.pi/agent/mcp.json', () => {
    const dflt = resolveHost('pi', env());
    expect(dflt.configPath).toBe('/home/u/.pi/agent/mcp.json');
    expect(dflt.label).toBe('Pi');
    expect(dflt.needsRestart).toBe(true);
    const custom = resolveHost('pi', env({ env: { PI_CODING_AGENT_DIR: '/pi-agent' } }));
    expect(custom.configPath).toBe('/pi-agent/mcp.json');
  });
});

describe('resolveCodexHome (CE.1 — the CODEX_HOME reader)', () => {
  it('honors $CODEX_HOME, else falls back to ~/.codex', () => {
    expect(resolveCodexHome(env())).toBe('/home/u/.codex');
    expect(resolveCodexHome(env({ env: { CODEX_HOME: '/xyz' } }))).toBe('/xyz');
  });
});

describe('parseHosts', () => {
  const noWarn = (): void => {
    /* warnings irrelevant to this assertion */
  };

  it('defaults to claude-code only when undefined/empty', () => {
    expect(parseHosts(undefined, noWarn)).toEqual(['claude-code']);
    expect(parseHosts('', noWarn)).toEqual(['claude-code']);
    expect(parseHosts('   ', noWarn)).toEqual(['claude-code']);
  });

  it('expands "all" to every host (incl. codex and pi)', () => {
    expect(parseHosts('all', noWarn)).toEqual([...ALL_HOSTS]);
    expect(ALL_HOSTS).toContain('codex');
    expect(ALL_HOSTS).toContain('pi');
  });

  it('parses codex and pi as valid ids', () => {
    expect(parseHosts('codex', noWarn)).toEqual(['codex']);
    expect(parseHosts('codex,claude-code', noWarn)).toEqual(['codex', 'claude-code']);
    expect(parseHosts('pi', noWarn)).toEqual(['pi']);
  });

  it('parses a comma list', () => {
    expect(parseHosts('claude-code,cursor', noWarn)).toEqual(['claude-code', 'cursor']);
  });

  it('warns and drops unknown ids', () => {
    const warns: string[] = [];
    const got = parseHosts('claude-desktop,bogus', (m) => warns.push(m));
    expect(got).toEqual(['claude-desktop']);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('bogus');
  });

  it('de-duplicates and tolerates whitespace', () => {
    expect(parseHosts(' cursor , cursor ,claude-code', noWarn)).toEqual(['cursor', 'claude-code']);
  });

  it('returns empty when every id is unknown (caller errors)', () => {
    const got = parseHosts('nope,nada', noWarn);
    expect(got).toEqual([] as HostId[]);
  });
});
