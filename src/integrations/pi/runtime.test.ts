/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-member-access */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createDefaultPiHarnessRuntimeAssets,
  getAvailablePiProviders,
  getResolvedPiModel,
  loadEffectivePiShellSettings,
  probeFullPiRuntime,
  readPiVersion,
} from './runtime.js';
import type { StreamingCliOptions, StreamingRecordContext } from '../../runtime/streaming_cli.js';

describe('probeFullPiRuntime', () => {
  it('requires the composed tool surface with generic mcp absent and uses a provider-free parent probe', async () => {
    let seen!: StreamingCliOptions;
    await expect(
      probeFullPiRuntime({
        cli: 'pi-fixture',
        cwd: '/repo',
        adapterEntry: '/adapter/index.ts',
        timeoutMs: 1000,
        parentTools: ['read', 'spawn_subagent'],
        runStreaming: async (options: StreamingCliOptions) => {
          seen = options;
          const ctx: StreamingRecordContext = {
            send: () => Promise.resolve(),
            complete: () => undefined,
            fail: (error) => {
              throw error;
            },
          };
          await options.onRecord(
            JSON.stringify({
              type: 'extension_ui_request',
              method: 'notify',
              message:
                'OPENSQUID_PI_FULL ' +
                JSON.stringify({
                  all: ['read', 'spawn_subagent'],
                  active: ['read', 'spawn_subagent'],
                }),
            }),
            ctx,
          );
          return { stdout: '', stderr: '', code: 0, completed: true };
        },
      }),
    ).resolves.toEqual({
      registeredTools: new Set(['read', 'spawn_subagent']),
      activeTools: new Set(['read', 'spawn_subagent']),
    });
    expect(seen.args).not.toContain('--provider');
    expect(seen.args).not.toContain('--model');
    expect(seen.env).toMatchObject({
      OPENSQUID_AUTOMATION: '1',
      OPENSQUID_LOOP_LAP: '1',
      OPENSQUID_SESSION_ID: 'opensquid-pi-full-probe-session',
      OPENSQUID_ITEM_ID: 'opensquid-pi-full-probe-item',
    });
    expect(seen.env?.OPENSQUID_EXECUTOR).toBeUndefined();
    expect(seen.env?.OPENSQUID_EXECUTOR_ID).toBeUndefined();

    await expect(
      probeFullPiRuntime({
        cli: 'pi-fixture',
        cwd: '/repo',
        adapterEntry: '/adapter/index.ts',
        timeoutMs: 1000,
        parentTools: ['read'],
        runStreaming: async (options: StreamingCliOptions) => {
          const ctx: StreamingRecordContext = {
            send: () => Promise.resolve(),
            complete: () => undefined,
            fail: (error) => {
              throw error;
            },
          };
          await options.onRecord(
            JSON.stringify({
              type: 'extension_ui_request',
              method: 'notify',
              message:
                'OPENSQUID_PI_FULL ' +
                JSON.stringify({ all: ['read', 'mcp'], active: ['read', 'mcp'] }),
            }),
            ctx,
          );
          return { stdout: '', stderr: '', code: 0, completed: true };
        },
      }),
    ).rejects.toThrow(/generic mcp/);
  });
});

describe('getAvailablePiProviders', () => {
  it('decodes provider/model availability from RPC responses', async () => {
    await expect(
      getAvailablePiProviders({
        cli: 'pi-fixture',
        cwd: '/repo',
        timeoutMs: 1000,
        runStreaming: async (options: StreamingCliOptions) => {
          const sent: Record<string, unknown>[] = [];
          const ctx: StreamingRecordContext = {
            send: (line) => {
              sent.push(JSON.parse(line) as Record<string, unknown>);
              return Promise.resolve();
            },
            complete: () => undefined,
            fail: (error) => {
              throw error;
            },
          };
          await options.onStart?.(ctx);
          await options.onRecord(
            JSON.stringify({
              type: 'response',
              id: sent[0]!.id,
              command: 'get_available_models',
              success: true,
              data: {
                models: [
                  { provider: 'anthropic', id: 'model-a' },
                  { provider: 'anthropic', id: 'model-b' },
                  { provider: 'openai', id: 'gpt-5' },
                ],
              },
            }),
            ctx,
          );
          return { stdout: '', stderr: '', code: 0, completed: true };
        },
      }),
    ).resolves.toEqual(
      new Map([
        ['anthropic', new Set(['model-a', 'model-b'])],
        ['openai', new Set(['gpt-5'])],
      ]),
    );
  });
});

describe('getResolvedPiModel', () => {
  it('reads the provider/model Pi resolved from user settings without selection flags', async () => {
    let args: string[] = [];
    await expect(
      getResolvedPiModel({
        cli: 'pi-fixture',
        cwd: '/repo',
        timeoutMs: 1000,
        runStreaming: async (options) => {
          args = options.args;
          const ctx: StreamingRecordContext = {
            send: () => Promise.resolve(),
            complete: () => undefined,
            fail: (error) => {
              throw error;
            },
          };
          await options.onStart?.(ctx);
          await options.onRecord(
            JSON.stringify({
              type: 'response',
              id: 'opensquid-get-state',
              command: 'get_state',
              success: true,
              data: { model: { provider: 'openai-codex', id: 'gpt-5.6-sol' } },
            }),
            ctx,
          );
          return { stdout: '', stderr: '', code: 0, completed: true };
        },
      }),
    ).resolves.toEqual({ provider: 'openai-codex', id: 'gpt-5.6-sol' });
    expect(args).not.toContain('--provider');
    expect(args).not.toContain('--model');
  });
});

describe('readPiVersion/loadEffectivePiShellSettings', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'opensquid-pi-runtime-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads Pi --version through the shared lifecycle', async () => {
    await expect(
      readPiVersion({
        cli: 'pi-fixture',
        cwd: '/repo',
        env: { HOME: '/tmp/home' },
        runOneShot: vi.fn(async (input) => {
          expect(input.cwd).toBe('/repo');
          expect(input.env).toMatchObject({ HOME: '/tmp/home' });
          expect(input.args).toEqual(['--version']);
          return 'v9.7.3\n';
        }),
      }),
    ).resolves.toBe('9.7.3');
  });

  it('uses global shell settings and ignores untrusted project settings under --no-approve', async () => {
    const project = join(dir, 'project');
    await mkdir(join(project, '.pi'), { recursive: true });
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({ shellCommandPrefix: 'global-prefix', shellPath: '/bin/global' }),
      'utf8',
    );
    await writeFile(
      join(project, '.pi', 'settings.json'),
      JSON.stringify({ shellCommandPrefix: 'project-prefix' }),
      'utf8',
    );
    await expect(
      loadEffectivePiShellSettings(project, { PI_CODING_AGENT_DIR: dir }),
    ).resolves.toEqual({ commandPrefix: 'global-prefix', shellPath: '/bin/global' });

    await writeFile(join(dir, 'settings.json'), '{bad', 'utf8');
    await expect(
      loadEffectivePiShellSettings(project, { PI_CODING_AGENT_DIR: dir }),
    ).rejects.toThrow();
  });
});

describe('createDefaultPiHarnessRuntimeAssets', () => {
  it('prevalidates once per loop target, memoizes success, and retries a failed readiness attempt', async () => {
    const order: string[] = [];
    const deps = {
      ensurePiMcpReady: vi.fn(async () => {
        order.push('mcp');
        return {
          adapterEntry: '/adapter/index.ts',
          adapterVersion: '4.6.2',
          configHash: 'cfg',
          cacheHash: 'cfg',
          mcpTools: new Set(['read']),
        };
      }),
      probeFullPiRuntime: vi.fn(async () => {
        order.push('full');
        return { registeredTools: new Set(['read']), activeTools: new Set(['read']) };
      }),
      getAvailablePiProviders: vi.fn(async () => {
        order.push('providers');
        return new Map([['openai-codex', new Set(['gpt-5.6-sol'])]]);
      }),
      getResolvedPiModel: vi.fn(async () => {
        order.push('resolved-model');
        return { provider: 'openai-codex', id: 'gpt-5.6-sol' };
      }),
      readPiVersion: vi.fn(async () => {
        order.push('version');
        return '9.7.3';
      }),
      loadEffectivePiShellSettings: vi.fn(async () => {
        order.push('settings');
        return { commandPrefix: 'source env.sh', shellPath: '/bin/zsh' };
      }),
      writePiRoleManifest: vi.fn(async () => {
        order.push('roles');
        return { manifestPath: '/manifest.json', manifestHash: 'f'.repeat(64), roles: [] };
      }),
    };
    const assets = createDefaultPiHarnessRuntimeAssets(
      { env: { HOME: '/tmp/home' }, opensquidRoot: '/source/opensquid' },
      deps,
    );
    const readiness = await assets.readiness({
      cli: 'pi-fixture',
      cwd: '/repo',
    });
    expect(order).toEqual([
      'mcp',
      'full',
      'providers',
      'resolved-model',
      'version',
      'settings',
      'roles',
    ]);
    expect(deps.ensurePiMcpReady).toHaveBeenCalledWith(
      expect.objectContaining({ opensquidRoot: '/source/opensquid' }),
    );
    expect(deps.probeFullPiRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        cli: 'pi-fixture',
        cwd: '/repo',
        adapterEntry: '/adapter/index.ts',
      }),
    );
    expect(readiness).toMatchObject({
      piVersion: '9.7.3',
      mcpAdapterVersion: '4.6.2',
      effectiveShell: { commandPrefix: 'source env.sh', shellPath: '/bin/zsh' },
    });
    expect(readiness.roleManifestPath).toBe('/manifest.json');
    expect(readiness.roleManifestHash).toBe('f'.repeat(64));

    order.length = 0;
    await expect(
      assets.readiness({
        cli: 'pi-fixture',
        cwd: '/repo',
      }),
    ).resolves.toBe(readiness);
    expect(order).toEqual([]);

    const retryAssets = createDefaultPiHarnessRuntimeAssets(
      { env: { HOME: '/tmp/home' }, opensquidRoot: '/source/opensquid' },
      deps,
    );
    deps.probeFullPiRuntime.mockRejectedValueOnce(new Error('transient full probe error'));
    await expect(
      retryAssets.readiness({
        cli: 'pi-fixture',
        cwd: '/repo',
      }),
    ).rejects.toThrow(/transient full probe error/);
    deps.probeFullPiRuntime.mockResolvedValueOnce({
      registeredTools: new Set(['read']),
      activeTools: new Set(['read']),
    });
    await expect(
      retryAssets.readiness({
        cli: 'pi-fixture',
        cwd: '/repo',
      }),
    ).resolves.toMatchObject({ piVersion: '9.7.3' });
  });
});
