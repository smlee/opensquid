/**
 * agent_bridge — mcp_config helper unit tests (WAB-SUB.2, 0.5.106).
 *
 * Coverage:
 *   - materializeDefaultMcpConfig: writes the .mcp.json-shaped document at
 *     the target path; idempotent across multiple calls
 *   - defaultMcpServers: includes both opensquid-mcp + opensquid-chat-bridge-mcp
 *   - resolveMcpConfigPath: env override wins; explicit path skips write;
 *     fall-through materializes default
 */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  defaultMcpConfigPath,
  defaultMcpServers,
  materializeDefaultMcpConfig,
  resolveMcpConfigPath,
  type McpConfigDocument,
} from './mcp_config.js';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'mcp-cfg-'));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('defaultMcpServers', () => {
  it('exposes both opensquid-mcp and opensquid-chat-bridge-mcp', () => {
    const servers = defaultMcpServers();
    expect(servers.opensquid?.command).toBe('opensquid-mcp');
    expect(servers['opensquid-chat']?.command).toBe('opensquid-chat-bridge-mcp');
  });

  it('attaches env when provided', () => {
    const servers = defaultMcpServers({ OPENSQUID_HOME: '/tmp/x' });
    expect(servers.opensquid?.env).toEqual({ OPENSQUID_HOME: '/tmp/x' });
  });
});

describe('materializeDefaultMcpConfig', () => {
  it('writes a JSON document with mcpServers at the target path', async () => {
    const target = join(tmpRoot, 'nested', 'mcp-config.json');
    const written = await materializeDefaultMcpConfig({ targetPath: target });
    expect(written).toBe(target);
    const raw = await readFile(target, 'utf8');
    const parsed = JSON.parse(raw) as McpConfigDocument;
    expect(parsed.mcpServers.opensquid?.command).toBe('opensquid-mcp');
    expect(parsed.mcpServers['opensquid-chat']?.command).toBe('opensquid-chat-bridge-mcp');
  });

  it('is idempotent — second write replaces the first cleanly', async () => {
    const target = join(tmpRoot, 'mcp-config.json');
    await materializeDefaultMcpConfig({ targetPath: target });
    const firstStat = await stat(target);
    await new Promise((r) => setTimeout(r, 5));
    await materializeDefaultMcpConfig({ targetPath: target });
    const secondStat = await stat(target);
    // Same path; size should match (deterministic content).
    expect(secondStat.size).toBe(firstStat.size);
  });

  it('honors daemonHome override for default path resolution', () => {
    const path = defaultMcpConfigPath('/tmp/customhome');
    expect(path).toBe('/tmp/customhome/agent-bridge/mcp-config.json');
  });
});

describe('resolveMcpConfigPath', () => {
  it('returns the env override path verbatim without writing', async () => {
    const envOverride = '/some/user/path.json';
    const out = await resolveMcpConfigPath({
      env: { OPENSQUID_AGENT_BRIDGE_MCP_CONFIG: envOverride },
      daemonHome: tmpRoot,
    });
    expect(out).toBe(envOverride);
    // No default file created.
    await expect(stat(join(tmpRoot, 'agent-bridge', 'mcp-config.json'))).rejects.toBeDefined();
  });

  it('returns the explicit path verbatim without writing when env unset', async () => {
    const explicit = join(tmpRoot, 'user-mcp.json');
    const out = await resolveMcpConfigPath({
      env: {},
      explicitPath: explicit,
      daemonHome: tmpRoot,
    });
    expect(out).toBe(explicit);
    // No default file created.
    await expect(stat(join(tmpRoot, 'agent-bridge', 'mcp-config.json'))).rejects.toBeDefined();
  });

  it('materializes the default config when env + explicitPath both unset', async () => {
    const out = await resolveMcpConfigPath({ env: {}, daemonHome: tmpRoot });
    expect(out).toBe(join(tmpRoot, 'agent-bridge', 'mcp-config.json'));
    const raw = await readFile(out, 'utf8');
    const parsed = JSON.parse(raw) as McpConfigDocument;
    expect(parsed.mcpServers.opensquid?.command).toBe('opensquid-mcp');
  });
});
