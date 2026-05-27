/**
 * Tests for host resolution + `--hosts` parsing (Track MMH.1).
 * Pure functions — no I/O, so platform is just an input.
 */

import { describe, expect, it } from 'vitest';

import {
  ALL_HOSTS,
  parseHosts,
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

  it('expands "all" to every host', () => {
    expect(parseHosts('all', noWarn)).toEqual([...ALL_HOSTS]);
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
