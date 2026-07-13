/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/array-type */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExtensionAPI } from './protocol.js';

import { PI_CLI_ENV, PI_ROLE_MANIFEST_HASH_ENV, PI_ROLE_MANIFEST_PATH_ENV } from './env.js';

const mocks = vi.hoisted(() => {
  const loadVerifiedRoleManifest = vi.fn(async () => ({
    version: 1,
    generatedBy: 'opensquid',
    roles: [
      {
        name: 'scope-architect',
        pack: 'source-pack',
        generatedName: 'opensquid-source-pack-scope-architect',
        description: 'scope role',
        systemPrompt: 'prompt',
        tools: [
          'read',
          'bash',
          'grep',
          'write',
          'workgraph_get',
          'recall',
          'read_state',
          'web_fetch',
        ],
        model: 'reasoning',
        packModels: {
          reasoning: {
            mode: 'subscription',
            provider: 'openai',
            model: 'gpt-5',
            description: '',
            args: [],
          },
        },
        filePath: '/roles/opensquid-source-pack-scope-architect.md',
        contentHash: '0'.repeat(64),
      },
    ],
  }));
  const loadModelsConfig = vi.fn(async (packModels?: Record<string, unknown>) => ({
    ...(packModels ?? {}),
    reasoning: {
      mode: 'subscription',
      provider: 'openai',
      model: 'gpt-5',
      description: '',
      args: [],
    },
  }));
  const run = vi.fn();
  const launcherConstruct = vi.fn();
  const resolveProjectRoot = vi.fn(async () => '/repo');
  return { loadVerifiedRoleManifest, loadModelsConfig, run, launcherConstruct, resolveProjectRoot };
});

const runtimeAssets = {
  systemPromptPath: '/pkg/context/pi-system-prompt.md',
  mcpAdapterExtensionPath: '/adapter/index.ts',
  projectorExtensionPath: '/pkg/dist/integrations/pi/projector.js',
  spawnSubagentExtensionPath: '/pkg/dist/integrations/pi/spawn_subagent.js',
  parentTools: ['read', 'spawn_subagent'],
  readiness: vi.fn(async () => undefined),
};

vi.mock('./runtime.js', () => ({
  createDefaultPiHarnessRuntimeAssets: () => runtimeAssets,
}));
vi.mock('../../runtime/subagents/roles.js', () => ({
  loadVerifiedRoleManifest: mocks.loadVerifiedRoleManifest,
}));
vi.mock('../../runtime/subagents/service.js', () => ({
  SubagentService: class {
    async single(task: { role: string; task: string }) {
      return { results: [await mocks.run({ role: { name: task.role }, task: task.task })] };
    }
    async parallel(tasks: Array<{ role: string; task: string }>) {
      return {
        results: await Promise.all(
          tasks.map((task) => mocks.run({ role: { name: task.role }, task: task.task })),
        ),
      };
    }
  },
}));
vi.mock('../../models/load_config.js', () => ({
  loadModelsConfig: mocks.loadModelsConfig,
}));
vi.mock('../../runtime/paths.js', () => ({
  resolveProjectRoot: mocks.resolveProjectRoot,
}));
vi.mock('./pi_subagent_launcher.js', () => ({
  PiSubagentLauncher: class {
    run = mocks.run;
    constructor(...args: unknown[]) {
      mocks.launcherConstruct(...args);
    }
  },
  usageFromResults: (
    results: Array<{
      details?:
        | {
            inputTokens?: number;
            outputTokens?: number;
            cacheReadTokens?: number;
            cacheWriteTokens?: number;
            costUsd?: number;
          }
        | {
            usage?: {
              inputTokens?: number;
              outputTokens?: number;
              cacheReadTokens?: number;
              cacheWriteTokens?: number;
              costUsd?: number;
            };
          };
    }>,
  ) =>
    results.reduce(
      (usage, result) => {
        const detail =
          result.details !== undefined && 'usage' in result.details
            ? result.details.usage
            : (result.details as
                | {
                    inputTokens?: number;
                    outputTokens?: number;
                    cacheReadTokens?: number;
                    cacheWriteTokens?: number;
                    costUsd?: number;
                  }
                | undefined);
        return {
          version: 1,
          inputTokens: usage.inputTokens + (detail?.inputTokens ?? 0),
          outputTokens: usage.outputTokens + (detail?.outputTokens ?? 0),
          cacheReadTokens: usage.cacheReadTokens + (detail?.cacheReadTokens ?? 0),
          cacheWriteTokens: usage.cacheWriteTokens + (detail?.cacheWriteTokens ?? 0),
          costUsd: usage.costUsd + (detail?.costUsd ?? 0),
        };
      },
      {
        version: 1,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
      },
    ),
  spawnSubagentDetails: ({ results, usage }: { results: unknown; usage: unknown }) => ({
    results,
    opensquidSubagentUsage: usage,
  }),
}));

import opensquidSpawnSubagent from './spawn_subagent.js';

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
}

interface RegisteredTool {
  name: string;
  parameters: {
    properties: {
      tasks: { maxItems: number };
    };
  };
  execute(
    toolCallId: string,
    rawParams: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: { cwd: string; model?: { provider: string; id: string } },
  ): Promise<ToolResult>;
}

describe('spawn_subagent extension', () => {
  let tool: RegisteredTool | undefined;

  beforeEach(() => {
    tool = undefined;
    runtimeAssets.readiness.mockClear();
    mocks.loadVerifiedRoleManifest.mockClear();
    mocks.loadModelsConfig.mockClear();
    mocks.launcherConstruct.mockClear();
    mocks.resolveProjectRoot.mockReset();
    mocks.resolveProjectRoot.mockResolvedValue('/repo');
    mocks.run.mockReset();
    process.env[PI_CLI_ENV] = 'pi-fixture';
    process.env[PI_ROLE_MANIFEST_PATH_ENV] = '/manifest.json';
    process.env[PI_ROLE_MANIFEST_HASH_ENV] = 'a'.repeat(64);
    opensquidSpawnSubagent({
      registerTool(def: RegisteredTool) {
        tool = def;
      },
    } as unknown as ExtensionAPI);
  });

  it('uses the preflight manifest env handoff and resolves per-role pack aliases without re-running readiness', async () => {
    mocks.run.mockResolvedValueOnce({
      role: 'scope-architect',
      text: 'single result',
      isError: false,
      details: {
        usage: {
          version: 1,
          inputTokens: 1,
          outputTokens: 2,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0,
        },
      },
    });

    const result = await tool!.execute(
      'tc-1',
      { role: 'scope-architect', task: 'do work', cwd: 'docs' },
      undefined,
      undefined,
      { cwd: '/repo/subdir', model: { provider: 'anthropic', id: 'claude-sonnet' } },
    );

    expect(tool?.name).toBe('spawn_subagent');
    expect(tool?.parameters.properties.tasks.maxItems).toBe(8);
    expect(runtimeAssets.readiness).not.toHaveBeenCalled();
    expect(mocks.loadVerifiedRoleManifest).toHaveBeenCalledWith('/manifest.json', 'a'.repeat(64));
    expect(mocks.loadModelsConfig).toHaveBeenCalledTimes(1);
    expect(mocks.loadModelsConfig).toHaveBeenCalledWith({
      reasoning: {
        mode: 'subscription',
        provider: 'openai',
        model: 'gpt-5',
        description: '',
        args: [],
      },
    });
    expect(mocks.launcherConstruct).toHaveBeenCalledWith(
      expect.objectContaining({ executorLoop: {} }),
      process.env,
    );
    expect(result).toMatchObject({
      content: [{ type: 'text', text: 'single result' }],
      details: {
        results: [{ role: 'scope-architect', text: 'single result', isError: false }],
        opensquidSubagentUsage: { version: 1, inputTokens: 1, outputTokens: 2, costUsd: 0 },
      },
    });
  });

  it('supports bounded parallel execution and preserves mixed failures without marking the whole call failed', async () => {
    mocks.run
      .mockResolvedValueOnce({
        role: 'scope-architect',
        text: 'ok child',
        isError: false,
        details: {
          usage: {
            version: 1,
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsd: 0,
          },
        },
      })
      .mockResolvedValueOnce({
        role: 'scope-architect',
        text: 'failed child',
        isError: true,
        details: {
          usage: {
            version: 1,
            inputTokens: 2,
            outputTokens: 3,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsd: 0.2,
          },
        },
      });

    const result = await tool!.execute(
      'tc-2',
      {
        tasks: [
          { role: 'scope-architect', task: 'one' },
          { role: 'scope-architect', task: 'two' },
        ],
      },
      undefined,
      undefined,
      { cwd: '/repo', model: { provider: 'anthropic', id: 'claude-sonnet' } },
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain('### scope-architect (ok)');
    expect(result.content[0]?.text).toContain('### scope-architect (error)');
    expect(result.details.opensquidSubagentUsage).toMatchObject({
      version: 1,
      inputTokens: 3,
      outputTokens: 4,
      costUsd: 0.2,
    });
  });

  it('fails closed on missing manifest env, hash mismatch, invalid mode selection, missing cli, absent project root, and all-error single execution', async () => {
    delete process.env[PI_ROLE_MANIFEST_HASH_ENV];
    await expect(
      tool!.execute('tc-env', { role: 'scope-architect', task: 'x' }, undefined, undefined, {
        cwd: '/repo',
        model: { provider: 'anthropic', id: 'claude-sonnet' },
      }),
    ).resolves.toMatchObject({
      isError: true,
      content: [expect.objectContaining({ text: expect.stringMatching(/manifest env/i) })],
    });

    process.env[PI_ROLE_MANIFEST_HASH_ENV] = 'a'.repeat(64);
    mocks.loadVerifiedRoleManifest.mockRejectedValueOnce(
      new Error('Role manifest hash mismatch for /manifest.json'),
    );
    await expect(
      tool!.execute('tc-hash', { role: 'scope-architect', task: 'x' }, undefined, undefined, {
        cwd: '/repo',
        model: { provider: 'anthropic', id: 'claude-sonnet' },
      }),
    ).resolves.toMatchObject({
      isError: true,
      content: [
        expect.objectContaining({ text: expect.stringContaining('Role manifest hash mismatch') }),
      ],
    });

    await expect(
      tool!.execute(
        'tc-3',
        { role: 'scope-architect', task: 'x', tasks: [{ role: 'scope-architect', task: 'y' }] },
        undefined,
        undefined,
        { cwd: '/repo', model: { provider: 'anthropic', id: 'claude-sonnet' } },
      ),
    ).resolves.toMatchObject({ isError: true });

    delete process.env[PI_CLI_ENV];
    await expect(
      tool!.execute('tc-4', { role: 'scope-architect', task: 'x' }, undefined, undefined, {
        cwd: '/repo',
        model: { provider: 'anthropic', id: 'claude-sonnet' },
      }),
    ).resolves.toMatchObject({ isError: true });

    process.env[PI_CLI_ENV] = 'pi-fixture';
    mocks.resolveProjectRoot.mockResolvedValueOnce(null as unknown as string);
    await expect(
      tool!.execute('tc-4b', { role: 'scope-architect', task: 'x' }, undefined, undefined, {
        cwd: '/repo',
        model: { provider: 'anthropic', id: 'claude-sonnet' },
      }),
    ).resolves.toMatchObject({
      isError: true,
      content: [
        expect.objectContaining({ type: 'text', text: expect.stringMatching(/project root/i) }),
      ],
    });

    mocks.run.mockResolvedValueOnce({
      role: 'scope-architect',
      text: 'single failed',
      isError: true,
      details: {
        usage: {
          version: 1,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0,
        },
      },
    });
    await expect(
      tool!.execute('tc-5', { role: 'scope-architect', task: 'x' }, undefined, undefined, {
        cwd: '/repo',
        model: { provider: 'anthropic', id: 'claude-sonnet' },
      }),
    ).resolves.toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'single failed' }],
    });
  });
});
