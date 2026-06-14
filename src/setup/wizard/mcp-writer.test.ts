/**
 * Tests for `writeOpensquidMcp` / `projectOpensquidMcp` (G.8 — Part A).
 *
 * Covers all fixtures from spec §"Test fixtures":
 *   - Empty `~/.claude.json` → adds both opensquid + opensquid-chat with marker
 *   - Existing broken `opensquid` (node dist/index.js) → REPLACED with correct path
 *   - Existing third-party mcpServer entries (claude.ai-Figma etc) → preserved verbatim
 *   - Re-running wizard → byte-identical output (idempotency)
 *   - Backup `.bak` written before mutation
 *   - Non-mcpServers top-level keys (per-project state) → preserved verbatim
 *
 * Each test uses its own tmpdir; no shared mutable state — parallel-safe.
 */

import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildDesiredEntries,
  isLegacyOpensquidEntry,
  projectOpensquidMcp,
  writeOpensquidMcp,
} from './mcp-writer.js';

const REPO_ROOT = '/fake/opensquid';

let dir: string;
let configPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'opensquid-mcp-writer-'));
  configPath = join(dir, '.claude.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function readJson(p: string): Promise<unknown> {
  return JSON.parse(await readFile(p, 'utf8')) as unknown;
}

describe('writeOpensquidMcp — empty / nonexistent config', () => {
  it('creates the file with both opensquid mcpServers entries when ~/.claude.json does not exist', async () => {
    const result = await writeOpensquidMcp(configPath, REPO_ROOT);
    expect(result.added).toEqual(['opensquid', 'opensquid-chat']);
    expect(result.replaced).toEqual([]);
    expect(result.preserved).toBe(0);

    const out = (await readJson(configPath)) as {
      mcpServers: Record<string, { command: string; args: string[]; '@opensquid'?: boolean }>;
    };
    expect(out.mcpServers.opensquid?.command).toBe('node');
    expect(out.mcpServers.opensquid?.args).toEqual([`${REPO_ROOT}/dist/mcp/server.js`]);
    expect(out.mcpServers.opensquid?.['@opensquid']).toBe(true);
    expect(out.mcpServers['opensquid-chat']?.args).toEqual([
      `${REPO_ROOT}/dist/mcp/chat-bridge-server.js`,
    ]);
    expect(out.mcpServers['opensquid-chat']?.['@opensquid']).toBe(true);
  });

  it('writes a .bak containing an empty object when ~/.claude.json did not exist', async () => {
    await writeOpensquidMcp(configPath, REPO_ROOT);
    const bak = await readJson(`${configPath}.bak`);
    expect(bak).toEqual({});
  });
});

describe('writeOpensquidMcp — legacy detection + replacement', () => {
  it('detects the broken `node <abs>/opensquid/dist/index.js` entry and replaces it with dist/mcp/server.js', async () => {
    const seed = {
      mcpServers: {
        opensquid: {
          type: 'stdio',
          command: 'node',
          args: ['/Users/USER/projects/opensquid/dist/index.js'],
          env: {},
        },
      },
    };
    await writeFile(configPath, JSON.stringify(seed, null, 2), 'utf8');

    const result = await writeOpensquidMcp(configPath, REPO_ROOT);
    // Only `opensquid` existed in the seed — it gets replaced; opensquid-chat
    // is added fresh.
    expect(result.replaced).toEqual(['opensquid']);
    expect(result.added).toEqual(['opensquid-chat']);

    const out = (await readJson(configPath)) as {
      mcpServers: { opensquid: { args: string[]; '@opensquid'?: boolean } };
    };
    expect(out.mcpServers.opensquid.args).toEqual([`${REPO_ROOT}/dist/mcp/server.js`]);
    expect(out.mcpServers.opensquid['@opensquid']).toBe(true);
  });

  it('recognises a prior @opensquid: true entry as ours and replaces it idempotently', async () => {
    const seed = {
      mcpServers: {
        opensquid: {
          type: 'stdio',
          command: 'node',
          args: [`${REPO_ROOT}/dist/mcp/server.js`],
          env: {},
          '@opensquid': true,
        },
      },
    };
    await writeFile(configPath, JSON.stringify(seed, null, 2), 'utf8');
    const result = await writeOpensquidMcp(configPath, REPO_ROOT);
    expect(result.replaced).toContain('opensquid');
  });
});

describe('writeOpensquidMcp — preserves third-party mcpServers + unknown top-level keys', () => {
  it('preserves unrelated mcpServers entries (claude.ai-Figma, Notion, Vercel) verbatim', async () => {
    const seed = {
      mcpServers: {
        'claude.ai-Figma': {
          type: 'http',
          url: 'https://figma.example/mcp',
          headers: { Authorization: 'Bearer x' },
        },
        'claude.ai-Notion': { type: 'stdio', command: 'npx', args: ['-y', '@notion/mcp'] },
      },
    };
    await writeFile(configPath, JSON.stringify(seed, null, 2), 'utf8');

    const result = await writeOpensquidMcp(configPath, REPO_ROOT);
    expect(result.added).toEqual(['opensquid', 'opensquid-chat']);
    expect(result.preserved).toBe(2);

    const out = (await readJson(configPath)) as {
      mcpServers: Record<string, unknown>;
    };
    expect(out.mcpServers['claude.ai-Figma']).toEqual(seed.mcpServers['claude.ai-Figma']);
    expect(out.mcpServers['claude.ai-Notion']).toEqual(seed.mcpServers['claude.ai-Notion']);
    expect(out.mcpServers.opensquid).toBeDefined();
    expect(out.mcpServers['opensquid-chat']).toBeDefined();
  });

  it('preserves unknown top-level keys (per-project state, telemetry, etc.) verbatim', async () => {
    const seed = {
      userID: 'abc-123',
      projects: { '/some/project': { history: ['cmd1', 'cmd2'] } },
      telemetry: { enabled: false, lastReported: '2026-01-01T00:00:00Z' },
      mcpServers: {},
    };
    await writeFile(configPath, JSON.stringify(seed, null, 2), 'utf8');

    await writeOpensquidMcp(configPath, REPO_ROOT);
    const out = (await readJson(configPath)) as Record<string, unknown>;
    expect(out.userID).toBe('abc-123');
    expect(out.projects).toEqual(seed.projects);
    expect(out.telemetry).toEqual(seed.telemetry);
  });
});

describe('writeOpensquidMcp — idempotency', () => {
  it('running the writer twice produces byte-identical output', async () => {
    const seed = {
      mcpServers: {
        'claude.ai-Figma': { type: 'http', url: 'https://figma.example/mcp' },
        opensquid: {
          type: 'stdio',
          command: 'node',
          args: ['/Users/USER/projects/opensquid/dist/index.js'],
        },
      },
      userID: 'persist-me',
    };
    await writeFile(configPath, JSON.stringify(seed, null, 2), 'utf8');

    await writeOpensquidMcp(configPath, REPO_ROOT);
    const first = await readFile(configPath, 'utf8');

    await writeOpensquidMcp(configPath, REPO_ROOT);
    const second = await readFile(configPath, 'utf8');

    expect(first).toBe(second);
  });
});

describe('projectOpensquidMcp — pure-function projection', () => {
  it('does not mutate the input object', () => {
    const input = { mcpServers: {}, other: 'thing' };
    const snapshot = JSON.parse(JSON.stringify(input)) as unknown;
    projectOpensquidMcp(input, REPO_ROOT);
    expect(input).toEqual(snapshot);
  });

  it('handles a totally-empty input (no mcpServers key)', () => {
    const { output, added, replaced, preserved } = projectOpensquidMcp({}, REPO_ROOT);
    expect(added).toEqual(['opensquid', 'opensquid-chat']);
    expect(replaced).toEqual([]);
    expect(preserved).toBe(0);
    expect(Object.keys(output.mcpServers ?? {})).toEqual(['opensquid', 'opensquid-chat']);
  });
});

describe('isLegacyOpensquidEntry', () => {
  it('detects the broken `node <abs>/opensquid/.../dist/index.js` arg shape', () => {
    expect(
      isLegacyOpensquidEntry({
        command: 'node',
        args: ['/Users/x/projects/opensquid/dist/index.js'],
      }),
    ).toBe(true);
  });

  it('detects via the @opensquid marker even if args have already been corrected', () => {
    expect(
      isLegacyOpensquidEntry({
        command: 'node',
        args: ['/abs/opensquid/dist/mcp/server.js'],
        '@opensquid': true,
      }),
    ).toBe(true);
  });

  it('does NOT trip on an unrelated user-authored MCP that mentions opensquid in a path', () => {
    expect(
      isLegacyOpensquidEntry({
        command: 'npx',
        args: ['my-opensquid-thing.js'],
      }),
    ).toBe(false);
  });
});

describe('buildDesiredEntries', () => {
  it('returns both opensquid + opensquid-chat with the marker', () => {
    const d = buildDesiredEntries(REPO_ROOT);
    expect(d.opensquid['@opensquid']).toBe(true);
    expect(d['opensquid-chat']['@opensquid']).toBe(true);
    expect(d.opensquid.args).toEqual([`${REPO_ROOT}/dist/mcp/server.js`]);
    expect(d['opensquid-chat'].args).toEqual([`${REPO_ROOT}/dist/mcp/chat-bridge-server.js`]);
  });

  it('emits the shipped BIN names with NO root — standalone default (wg-798ce60dbb13)', () => {
    const d = buildDesiredEntries();
    expect(d.opensquid.command).toBe('opensquid-mcp');
    expect(d.opensquid.args).toEqual([]);
    expect(d['opensquid-chat'].command).toBe('opensquid-chat-bridge-mcp');
    expect(d['opensquid-chat'].args).toEqual([]);
    expect(d.opensquid['@opensquid']).toBe(true);
    expect(d['opensquid-chat']['@opensquid']).toBe(true);
  });
});
