import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertExactEffectivePiConfig,
  buildExpectedPiMcpConfig,
  computePiServerHash,
  loadEffectivePiConfig,
  projectPiMcpConfig,
  writePiMcpConfig,
} from './mcp_config.js';

let dir: string;
let cwd: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'opensquid-pi-mcp-config-'));
  cwd = join(dir, 'repo');
  env = { HOME: join(dir, 'home'), PI_CODING_AGENT_DIR: join(dir, 'agent') };
  await mkdir(cwd, { recursive: true });
  await mkdir(join(env.HOME!, '.config', 'mcp'), { recursive: true });
  await mkdir(env.PI_CODING_AGENT_DIR!, { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const targetPath = () => join(env.PI_CODING_AGENT_DIR!, 'mcp.json');
const expected = () => buildExpectedPiMcpConfig({ path: targetPath() });

describe('projectPiMcpConfig/writePiMcpConfig', () => {
  it('writes atomically, preserves unrelated fields, and records a backup', async () => {
    const path = targetPath();
    await writeFile(
      path,
      JSON.stringify({ keep: { me: true }, mcpServers: { other: { command: 'x' } } }, null, 2),
      'utf8',
    );
    const result = await writePiMcpConfig(path, expected());
    const output = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    expect(result.preserved).toBe(1);
    expect(output.keep).toEqual({ me: true });
    expect((output.mcpServers as Record<string, unknown>).opensquid).toBeDefined();
    expect((output.mcpServers as Record<string, unknown>).other).toEqual({ command: 'x' });
    expect(JSON.parse(await readFile(`${path}.bak`, 'utf8'))).toEqual({
      keep: { me: true },
      mcpServers: { other: { command: 'x' } },
    });
  });

  it('is idempotent for identical reruns', async () => {
    const path = targetPath();
    await writePiMcpConfig(path, expected());
    const first = await readFile(path, 'utf8');
    await writePiMcpConfig(path, expected());
    const second = await readFile(path, 'utf8');
    expect(second).toBe(first);
  });

  it('merges expected settings and servers without mutating the input object', () => {
    const input = {
      settings: { requestTimeoutMs: 1000 },
      mcpServers: { foreign: { command: 'x' } },
    };
    const snapshot = structuredClone(input);
    const projected = projectPiMcpConfig(input, expected());
    expect(input).toEqual(snapshot);
    expect(projected.output.settings?.requestTimeoutMs).toBe(1000);
    expect(projected.output.mcpServers?.foreign).toEqual({ command: 'x' });
  });
});

describe('computePiServerHash', () => {
  it('matches the adapter identity rules for env interpolation, cwd expansion, and bearer-token resolution', () => {
    const definition = {
      command: 'node',
      args: ['server.js'],
      env: { SESSION: '${SESSION_ID}' },
      cwd: '~/repo',
      headers: { authorization: 'Bearer ${TOKEN}' },
      auth: 'bearer' as const,
      bearerTokenEnv: 'TOKEN',
      excludeTools: ['x'],
      lifecycle: 'eager' as const,
      requestTimeoutMs: 1,
      idleTimeout: 2,
      debug: true,
    };
    const resolved = computePiServerHash(definition, {
      ...env,
      SESSION_ID: 'sid-1',
      TOKEN: 'tok-1',
    });
    expect(resolved).toBe(
      computePiServerHash(
        {
          ...definition,
          env: { SESSION: 'sid-1' },
          cwd: join(env.HOME!, 'repo'),
          headers: { authorization: 'Bearer tok-1' },
          bearerToken: 'tok-1',
        },
        env,
      ),
    );
  });

  it('ignores runtime-only lifecycle/request settings but diverges on identity changes', () => {
    const base = expected().raw.mcpServers.opensquid;
    expect(
      computePiServerHash({ ...base, lifecycle: 'eager', requestTimeoutMs: 1, debug: true }),
    ).toBe(computePiServerHash(base));
    expect(computePiServerHash({ ...base, env: { A: '1' } })).not.toBe(computePiServerHash(base));
    expect(computePiServerHash({ ...base, cwd: '~/x' }, env)).not.toBe(computePiServerHash(base));
  });
});

describe('loadEffectivePiConfig/assertExactEffectivePiConfig', () => {
  it('accepts the exact authoritative global Pi config', async () => {
    await writePiMcpConfig(targetPath(), expected());
    const effective = await loadEffectivePiConfig({ cwd, env: { ...process.env, ...env } });
    expect(() => assertExactEffectivePiConfig(effective, expected())).not.toThrow();
  });

  it('rejects malformed source files with the source path', async () => {
    await writeFile(targetPath(), JSON.stringify(expected().raw), 'utf8');
    await writeFile(join(env.HOME!, '.config', 'mcp', 'mcp.json'), '{"mcpServers":[]}', 'utf8');
    const effective = await loadEffectivePiConfig({ cwd, env: { ...process.env, ...env } });
    expect(() => assertExactEffectivePiConfig(effective, expected())).toThrow(/mcp\.json/);
  });

  it('rejects a foreign shared-global server before launch', async () => {
    await writePiMcpConfig(targetPath(), expected());
    await writeFile(
      join(env.HOME!, '.config', 'mcp', 'mcp.json'),
      JSON.stringify(
        { mcpServers: { evil: { command: 'malicious', lifecycle: 'eager' } } },
        null,
        2,
      ),
      'utf8',
    );
    const effective = await loadEffectivePiConfig({ cwd, env: { ...process.env, ...env } });
    expect(() => assertExactEffectivePiConfig(effective, expected())).toThrow(/evil/);
    expect(() => assertExactEffectivePiConfig(effective, expected())).toThrow(/mcp\.json/);
  });

  it('accepts a compatible shared project projection when its merged definition remains authoritative', async () => {
    await writePiMcpConfig(targetPath(), expected());
    await writeFile(
      join(cwd, '.mcp.json'),
      JSON.stringify(
        {
          mcpServers: {
            opensquid: { command: 'opensquid-mcp', args: [] },
            'opensquid-chat': { command: 'opensquid-chat-bridge-mcp', args: [] },
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    const effective = await loadEffectivePiConfig({ cwd, env: { ...process.env, ...env } });
    expect(() => assertExactEffectivePiConfig(effective, expected())).not.toThrow();
  });

  it('rejects same-key overrides from project config with source-aware diagnostics', async () => {
    await writePiMcpConfig(targetPath(), expected());
    await mkdir(join(cwd, '.pi'), { recursive: true });
    await writeFile(
      join(cwd, '.pi', 'mcp.json'),
      JSON.stringify({ mcpServers: { opensquid: { lifecycle: 'eager' } } }, null, 2),
      'utf8',
    );
    const effective = await loadEffectivePiConfig({ cwd, env: { ...process.env, ...env } });
    expect(() => assertExactEffectivePiConfig(effective, expected())).toThrow(
      /definition mismatch|outside/,
    );
    expect(() => assertExactEffectivePiConfig(effective, expected())).toThrow(/\.pi\/mcp\.json/);
  });

  it('rejects imports and locked setting overrides', async () => {
    await writePiMcpConfig(targetPath(), expected());
    await writeFile(
      targetPath(),
      JSON.stringify({
        ...expected().raw,
        imports: ['cursor'],
        settings: { ...expected().raw.settings, toolPrefix: 'server' },
      }),
      'utf8',
    );
    const effective = await loadEffectivePiConfig({ cwd, env: { ...process.env, ...env } });
    expect(() => assertExactEffectivePiConfig(effective, expected())).toThrow(/imports|toolPrefix/);
  });

  it('rejects global directTools overrides even when the target servers are correct', async () => {
    await writePiMcpConfig(targetPath(), expected());
    await writeFile(
      targetPath(),
      JSON.stringify({
        ...expected().raw,
        settings: { ...expected().raw.settings, directTools: true },
      }),
      'utf8',
    );
    const effective = await loadEffectivePiConfig({ cwd, env: { ...process.env, ...env } });
    expect(() => assertExactEffectivePiConfig(effective, expected())).toThrow(/directTools/);
  });
});
