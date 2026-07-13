import { describe, expect, it, vi } from 'vitest';
import { bootstrapPiMcpCache, ensurePiMcpReady, probePiMcpTools } from './bootstrap.js';
import { buildExpectedPiMcpConfig } from './mcp_config.js';
import type { StreamingCliOptions, StreamingCliResult } from '../../runtime/streaming_cli.js';

const expectedPath = '/tmp/pi-agent/mcp.json';
const expected = buildExpectedPiMcpConfig({ path: expectedPath });
const validCache = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: 1,
    servers: {
      opensquid: {
        configHash: expected.hash,
        cachedAt: Date.now(),
        tools: [...expected.mcpTools].map((name) => ({ name })),
        resources: [],
        ...overrides,
      },
    },
  });

describe('bootstrapPiMcpCache', () => {
  it('waits for get_state then polls until the cache hash and tool metadata are valid', async () => {
    let cacheText = JSON.stringify({ version: 1, servers: {} });
    const runStreaming = vi.fn(
      async (options: StreamingCliOptions): Promise<StreamingCliResult> => {
        const sent: string[] = [];
        const ctx = {
          send: (record: string) => {
            sent.push(record);
            return Promise.resolve();
          },
          complete: vi.fn(),
          fail: (error: Error) => {
            throw error;
          },
        };
        await options.onStart?.(ctx);
        cacheText = validCache();
        await options.onRecord(
          JSON.stringify({
            type: 'response',
            id: 'opensquid-pi-bootstrap-state',
            command: 'get_state',
            success: true,
          }),
          ctx,
        );
        expect(sent).toHaveLength(1);
        expect(ctx.complete).toHaveBeenCalled();
        return { stdout: '', stderr: '', code: 0, completed: true };
      },
    );
    await expect(
      bootstrapPiMcpCache({
        cli: 'pi',
        cwd: '/repo',
        adapterEntry: '/adapter/index.ts',
        expectedHash: expected.hash,
        expectedTools: expected.mcpTools,
        timeoutMs: 100,
        runStreaming,
        readText: () => Promise.resolve(cacheText),
        now: (() => {
          let tick = 0;
          return () => tick++;
        })(),
        sleep: () => Promise.resolve(),
      }),
    ).resolves.toBe(expected.hash);
  });

  it('times out when the cache stays absent, stale, corrupt, or incomplete', async () => {
    const runStreaming = async (options: StreamingCliOptions): Promise<StreamingCliResult> => {
      const ctx = {
        send: () => Promise.resolve(),
        complete: () => undefined,
        fail: (error: Error) => {
          throw error;
        },
      };
      await options.onStart?.(ctx);
      await options.onRecord(
        JSON.stringify({
          type: 'response',
          id: 'opensquid-pi-bootstrap-state',
          command: 'get_state',
          success: true,
        }),
        ctx,
      );
      return { stdout: '', stderr: '', code: 0, completed: true };
    };
    let cacheText = validCache({ tools: [] });
    await expect(
      bootstrapPiMcpCache({
        cli: 'pi',
        cwd: '/repo',
        adapterEntry: '/adapter/index.ts',
        expectedHash: expected.hash,
        expectedTools: expected.mcpTools,
        timeoutMs: 4,
        runStreaming,
        readText: () => Promise.resolve(cacheText),
        now: (() => {
          let tick = 0;
          return () => tick++;
        })(),
        sleep: () => {
          cacheText = JSON.stringify({ version: 1, servers: {} });
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow(/timed out/);
  });
});

describe('probePiMcpTools', () => {
  it('accepts the exact MCP-owned tool set and rejects generic mcp absence', async () => {
    const runStreaming = async (options: StreamingCliOptions): Promise<StreamingCliResult> => {
      await options.onRecord(
        JSON.stringify({
          type: 'extension_ui_request',
          method: 'notify',
          message:
            'OPENSQUID_PI_PROBE ' +
            JSON.stringify({
              all: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', ...expected.mcpTools],
              active: [...expected.mcpTools],
            }),
        }),
        {
          send: () => Promise.resolve(),
          complete: () => undefined,
          fail: (error: Error) => {
            throw error;
          },
        },
      );
      return { stdout: '', stderr: '', code: 0, completed: true };
    };
    await expect(
      probePiMcpTools({
        cli: 'pi',
        cwd: '/repo',
        adapterEntry: '/adapter/index.ts',
        expected: expected.mcpTools,
        timeoutMs: 100,
        runStreaming,
        readText: () => Promise.resolve(validCache()),
        makeTempDir: () => Promise.resolve('/tmp/probe'),
        writeText: () => Promise.resolve(),
        cleanupDir: () => Promise.resolve(),
      }),
    ).resolves.toEqual({ names: new Set(expected.mcpTools), cacheHash: expected.hash });
  });

  it('fails when generic mcp survives into the probe', async () => {
    const runStreaming = async (options: StreamingCliOptions): Promise<StreamingCliResult> => {
      await options.onRecord(
        JSON.stringify({
          type: 'extension_ui_request',
          method: 'notify',
          message:
            'OPENSQUID_PI_PROBE ' +
            JSON.stringify({
              all: ['mcp', 'read', ...expected.mcpTools],
              active: [...expected.mcpTools],
            }),
        }),
        {
          send: () => Promise.resolve(),
          complete: () => undefined,
          fail: (error: Error) => {
            throw error;
          },
        },
      );
      return { stdout: '', stderr: '', code: 0, completed: true };
    };
    await expect(
      probePiMcpTools({
        cli: 'pi',
        cwd: '/repo',
        adapterEntry: '/adapter/index.ts',
        expected: expected.mcpTools,
        timeoutMs: 100,
        runStreaming,
        readText: () => Promise.resolve(validCache()),
        makeTempDir: () => Promise.resolve('/tmp/probe'),
        writeText: () => Promise.resolve(),
        cleanupDir: () => Promise.resolve(),
      }),
    ).rejects.toThrow(/generic mcp/);
  });

  it('fails when unexpected direct tools leak into the MCP-only probe', async () => {
    const runStreaming = async (options: StreamingCliOptions): Promise<StreamingCliResult> => {
      await options.onRecord(
        JSON.stringify({
          type: 'extension_ui_request',
          method: 'notify',
          message:
            'OPENSQUID_PI_PROBE ' +
            JSON.stringify({
              all: ['read', ...expected.mcpTools, 'chat_proxy'],
              active: [...expected.mcpTools],
            }),
        }),
        {
          send: () => Promise.resolve(),
          complete: () => undefined,
          fail: (error: Error) => {
            throw error;
          },
        },
      );
      return { stdout: '', stderr: '', code: 0, completed: true };
    };
    await expect(
      probePiMcpTools({
        cli: 'pi',
        cwd: '/repo',
        adapterEntry: '/adapter/index.ts',
        expected: expected.mcpTools,
        timeoutMs: 100,
        runStreaming,
        readText: () => Promise.resolve(validCache()),
        makeTempDir: () => Promise.resolve('/tmp/probe'),
        writeText: () => Promise.resolve(),
        cleanupDir: () => Promise.resolve(),
      }),
    ).rejects.toThrow(/unexpected direct tools/);
  });
});

describe('ensurePiMcpReady', () => {
  it('prevalidates config, installs adapter, bootstraps cache, and probes MCP tools in order', async () => {
    const order: string[] = [];
    const runtime = await ensurePiMcpReady(
      { cli: 'pi', cwd: '/repo', env: { PI_CODING_AGENT_DIR: '/tmp/pi-agent' }, timeoutMs: 100 },
      {
        loadEffectiveConfig: () => {
          order.push('load');
          return Promise.resolve({
            sources: [
              {
                id: 'pi-global',
                path: expectedPath,
                scope: 'global',
                kind: 'pi',
                raw: expected.raw,
              },
            ],
            merged: {
              mcpServers: expected.raw.mcpServers,
              imports: [],
              settings: expected.raw.settings,
            },
            serverProvenance: new Map([
              ['opensquid', { id: 'pi-global', path: expectedPath, scope: 'global', kind: 'pi' }],
              [
                'opensquid-chat',
                { id: 'pi-global', path: expectedPath, scope: 'global', kind: 'pi' },
              ],
            ]),
            settingProvenance: new Map(
              Object.keys(expected.raw.settings).map((key) => [
                key,
                { id: 'pi-global', path: expectedPath, scope: 'global', kind: 'pi' },
              ]),
            ),
            importProvenance: [],
          });
        },
        ensureAdapterAvailable: () => {
          order.push('install');
          return Promise.resolve({ adapterEntry: '/adapter/index.ts', version: '7.3.1' });
        },
        bootstrapCache: () => {
          order.push('bootstrap');
          return Promise.resolve(expected.hash);
        },
        probeMcpTools: () => {
          order.push('probe');
          return Promise.resolve({ names: new Set(expected.mcpTools), cacheHash: expected.hash });
        },
      },
    );
    expect(order).toEqual(['load', 'install', 'bootstrap', 'probe']);
    expect(runtime).toEqual({
      adapterEntry: '/adapter/index.ts',
      adapterVersion: '7.3.1',
      configHash: expected.hash,
      cacheHash: expected.hash,
      mcpTools: new Set(expected.mcpTools),
    });
  });
});
