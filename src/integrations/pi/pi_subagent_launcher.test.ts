/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/array-type */
import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import {
  PiSubagentLauncher,
  piExecutorSpawnArgs,
  spawnSubagentDetails,
  usageFromResults,
} from './pi_subagent_launcher.js';
import { PI_ROLE_MANIFEST_HASH_ENV, PI_ROLE_MANIFEST_PATH_ENV } from './env.js';
import type { StreamingCliOptions, StreamingRecordContext } from '../../runtime/streaming_cli.js';
import type { ProcControl } from '../../runtime/spawn_lifecycle.js';
import { SubagentAbortError } from '../../runtime/subagents/supervisor.js';
import type { ValidatedSubagentTask } from '../../runtime/subagents/types.js';

const TASK: ValidatedSubagentTask = {
  role: {
    name: 'scope-architect',
    pack: 'source-pack',
    generatedName: 'opensquid-source-pack-scope-architect',
    description: 'scope role',
    systemPrompt: '## Role instructions\nWrite the docs only.',
    tools: ['read', 'bash', 'grep', 'write', 'workgraph_get', 'recall', 'read_state', 'web_fetch'],
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
  task: 'author the scope doc',
  cwd: '/repo/docs',
};
const PARENT_ENV = {
  OPENSQUID_SESSION_ID: 'attempt-1',
  OPENSQUID_ITEM_ID: 'wg-1',
  OPENSQUID_AUTOMATION: '1',
  OPENSQUID_LOOP_LAP: '1',
  [PI_ROLE_MANIFEST_PATH_ENV]: '/manifest.json',
  [PI_ROLE_MANIFEST_HASH_ENV]: 'a'.repeat(64),
};

function aliasesByRole(
  aliases: Readonly<
    Record<
      string,
      { mode: 'subscription' | 'api' | 'local' | 'mcp'; provider?: string; model?: string }
    >
  >,
): ReadonlyMap<
  string,
  Readonly<
    Record<
      string,
      { mode: 'subscription' | 'api' | 'local' | 'mcp'; provider?: string; model?: string }
    >
  >
> {
  return new Map([
    [
      TASK.role.generatedName,
      Object.fromEntries(
        Object.entries(aliases).map(([name, alias]) => [
          name,
          alias.model !== undefined && alias.provider === undefined
            ? { ...alias, provider: 'anthropic' }
            : alias,
        ]),
      ),
    ],
  ]);
}

describe('PiSubagentLauncher', () => {
  it('omits provider/model flags for native Pi inheritance and emits them only for an explicit role override', () => {
    const options = {
      cli: 'pi',
      systemPromptPath: '/system.md',
      adapterExtensionPath: '/adapter.js',
      projectorExtensionPath: '/projector.js',
    };
    const inherited = piExecutorSpawnArgs(options, {}, TASK.role, '/role.md');
    expect(inherited).not.toContain('--provider');
    expect(inherited).not.toContain('--model');

    const explicit = piExecutorSpawnArgs(
      options,
      { provider: 'openai-codex', model: 'gpt-explicit' },
      TASK.role,
      '/role.md',
    );
    const providerIndex = explicit.indexOf('--provider');
    expect(explicit.slice(providerIndex, providerIndex + 4)).toEqual([
      '--provider',
      'openai-codex',
      '--model',
      'gpt-explicit',
    ]);
  });

  it('does not launch another executor lap after the parent run is human-paused', async () => {
    const runStreaming = vi.fn();
    const launcher = new PiSubagentLauncher(
      {
        cli: 'pi-fixture',
        systemPromptPath: '/system.md',
        adapterExtensionPath: '/adapter.js',
        projectorExtensionPath: '/projector.js',
      },
      { ...PARENT_ENV, OPENSQUID_RUN_ID: 'run-paused' },
      {
        runStreaming,
        procControl: {
          spawn: vi.fn(),
          kill: vi.fn(),
          setTimeout,
          clearTimeout,
          onExit: vi.fn(),
          offExit: vi.fn(),
        },
        makeTempDir: async () => '/tmp/child',
        writeText: async () => undefined,
        cleanupDir: async () => undefined,
        readText: async () => 'baseline',
        listProcesses: vi.fn(() =>
          Promise.resolve([
            {
              executorId: 'parent-paused',
              processInstanceId: 'parent-process',
              actor: 'parent' as const,
              wgId: 'wg-1',
              runId: 'run-paused',
              role: 'orchestrator',
              pid: 123,
              processGroupId: 123,
              processStartIdentity: 'start-123',
              status: 'shutdown_requested' as const,
              startedAtMs: 1,
              updatedAtMs: 2,
              latestAction: {
                actionId: 'action-stop',
                action: 'graceful_stop' as const,
                requestedBy: 'web' as const,
                authorizedBy: 'web:user-1',
                requestedAtMs: 2,
                appliedAtMs: 3,
              },
              availableActions: ['terminate', 'force_kill'] as const,
            },
          ]),
        ),
      },
    );

    await expect(launcher.run(TASK, new AbortController().signal)).resolves.toMatchObject({
      isError: true,
      controlOutcome: {
        kind: 'PROCESS_PAUSED',
        action: 'graceful_stop',
        actionId: 'action-stop',
      },
    });
    expect(runStreaming).not.toHaveBeenCalled();
  });

  it('spawns the exact isolated child command, preserves baseline + role prompt, requests an owned process group, and resolves per-role aliases', async () => {
    let options: StreamingCliOptions | undefined;
    const written = new Map<string, string>();
    const outputLines: { childId: string; role: string; line: string }[] = [];
    const launcher = new PiSubagentLauncher(
      {
        cli: 'pi-fixture',
        provider: 'anthropic',
        model: 'claude-sonnet',
        modelAliasesByRole: aliasesByRole({
          reasoning: { mode: 'subscription', provider: 'openai', model: 'gpt-5' },
        }),
        systemPromptPath: '/pkg/context/pi-system-prompt.md',
        adapterExtensionPath: '/adapter/index.ts',
        projectorExtensionPath: '/pkg/dist/integrations/pi/projector.js',
        childIdFactory: () => 'fixed-id',
        onStderrLine: (event) => outputLines.push(event),
      },
      PARENT_ENV,
      {
        runStreaming: async (input) => {
          options = input;
          input.onStderrLine?.('After-phase report — research complete');
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
          await input.onStart?.(ctx);
          expect(sent[0]).toEqual({
            id: expect.stringContaining('prompt'),
            type: 'prompt',
            message: 'author the scope doc',
          });
          await input.onRecord(
            JSON.stringify({ type: 'response', id: sent[0]!.id, command: 'prompt', success: true }),
            ctx,
          );
          await input.onRecord(
            JSON.stringify({
              type: 'message_end',
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'done' }],
                stopReason: 'stop',
                usage: {
                  input: 1,
                  output: 2,
                  cacheRead: 3,
                  cacheWrite: 4,
                  cost: { total: 0.1 },
                },
              },
            }),
            ctx,
          );
          await input.onRecord(JSON.stringify({ type: 'agent_settled' }), ctx);
          const statsId = sent[1]!.id;
          await input.onRecord(
            JSON.stringify({
              type: 'response',
              id: statsId,
              command: 'get_session_stats',
              success: true,
              data: {
                tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 },
                cost: 0,
              },
            }),
            ctx,
          );
          return { stdout: '', stderr: '', code: 0, completed: true };
        },
        procControl: {
          spawn: vi.fn(),
          kill: vi.fn(),
          setTimeout,
          clearTimeout,
          onExit: vi.fn(),
          offExit: vi.fn(),
        },
        makeTempDir: async () => '/tmp/child',
        writeText: async (path, text) => {
          written.set(path, text);
        },
        cleanupDir: async () => undefined,
        readText: async () => '# OpenSquid autonomous lap\nBaseline text',
      },
    );

    const result = await launcher.run(TASK, new AbortController().signal);

    expect(result).toEqual({
      role: 'scope-architect',
      text: 'done',
      isError: false,
      details: {
        usage: {
          version: 1,
          inputTokens: 10,
          outputTokens: 20,
          cacheReadTokens: 30,
          cacheWriteTokens: 40,
          costUsd: 0,
        },
      },
    });
    expect(options?.processGroup).toBe('own');
    expect(options?.args).toEqual([
      '--mode',
      'rpc',
      '--no-session',
      '--no-approve',
      '--provider',
      'openai',
      '--model',
      'gpt-5',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
      '--system-prompt',
      '/tmp/child/system-prompt.md',
      '--append-system-prompt',
      '',
      '-e',
      '/adapter/index.ts',
      '-e',
      '/pkg/dist/integrations/pi/projector.js',
      '--tools',
      'read,bash,grep,write,workgraph_get,recall,read_state,web_fetch',
    ]);
    expect(options?.env).toMatchObject({
      OPENSQUID_SESSION_ID: expect.stringMatching(/^pi-child-fixed-id-lap-1-/u),
      OPENSQUID_ITEM_ID: 'wg-1',
      OPENSQUID_AUTOMATION: '1',
      OPENSQUID_LOOP_LAP: '1',
      OPENSQUID_EXECUTOR: '1',
      OPENSQUID_EXECUTOR_ID: 'pi-child-fixed-id',
      [PI_ROLE_MANIFEST_PATH_ENV]: '/manifest.json',
      [PI_ROLE_MANIFEST_HASH_ENV]: 'a'.repeat(64),
    });
    expect(options?.env?.OPENSQUID_SUBAGENT).toBeUndefined();
    expect(written.get('/tmp/child/system-prompt.md')).toContain('Baseline text');
    expect(written.get('/tmp/child/system-prompt.md')).toContain('## Role instructions');
    expect(outputLines).toEqual([
      {
        childId: 'pi-child-fixed-id',
        role: 'scope-architect',
        line: 'After-phase report — research complete',
      },
    ]);
  });

  it('rejects every incomplete role override instead of silently inheriting or falling back', async () => {
    let options: StreamingCliOptions | undefined;
    const providerSwitch = new PiSubagentLauncher(
      {
        cli: 'pi-fixture',
        provider: 'anthropic',
        model: 'claude-sonnet',
        modelAliasesByRole: aliasesByRole({
          reasoning: { mode: 'subscription', provider: 'openai' },
        }),
        systemPromptPath: '/pkg/context/pi-system-prompt.md',
        adapterExtensionPath: '/adapter/index.ts',
        projectorExtensionPath: '/pkg/dist/integrations/pi/projector.js',
      },
      PARENT_ENV,
      {
        runStreaming: async (input) => {
          options = input;
          const ctx: StreamingRecordContext = {
            send: () => Promise.resolve(),
            complete: () => undefined,
            fail: (error) => {
              throw error;
            },
          };
          await input.onStart?.(ctx);
          await input.onRecord(
            JSON.stringify({
              type: 'response',
              id: 'pi-child-prompt',
              command: 'prompt',
              success: true,
            }),
            ctx,
          );
          await input.onRecord(JSON.stringify({ type: 'agent_settled' }), ctx);
          await input.onRecord(
            JSON.stringify({
              type: 'response',
              id: 'pi-child-stats',
              command: 'get_session_stats',
              success: true,
              data: { tokens: { input: 1, output: 1 }, cost: 0 },
            }),
            ctx,
          );
          return { stdout: '', stderr: '', code: 0, completed: true };
        },
        procControl: {
          spawn: vi.fn(),
          kill: vi.fn(),
          setTimeout,
          clearTimeout,
          onExit: vi.fn(),
          offExit: vi.fn(),
        },
        makeTempDir: async () => '/tmp/child',
        writeText: async () => undefined,
        cleanupDir: async () => undefined,
        readText: async () => 'baseline',
      },
    );
    await expect(providerSwitch.run(TASK, new AbortController().signal)).resolves.toMatchObject({
      isError: true,
      text: expect.stringContaining('explicit provider/model alias'),
    });
    expect(options).toBeUndefined();

    const unusable = new PiSubagentLauncher(
      {
        cli: 'pi-fixture',
        provider: 'anthropic',
        model: 'claude-sonnet',
        modelAliasesByRole: aliasesByRole({
          reasoning: { mode: 'api', provider: 'openai' },
        }),
        systemPromptPath: '/pkg/context/pi-system-prompt.md',
        adapterExtensionPath: '/adapter/index.ts',
        projectorExtensionPath: '/pkg/dist/integrations/pi/projector.js',
      },
      PARENT_ENV,
      {
        runStreaming: async () => ({ stdout: '', stderr: '', code: 0, completed: true }),
        procControl: {
          spawn: vi.fn(),
          kill: vi.fn(),
          setTimeout,
          clearTimeout,
          onExit: vi.fn(),
          offExit: vi.fn(),
        },
        makeTempDir: async () => '/tmp/child',
        writeText: async () => undefined,
        cleanupDir: async () => undefined,
        readText: async () => 'baseline',
      },
    );
    await expect(unusable.run(TASK, new AbortController().signal)).resolves.toMatchObject({
      isError: true,
      text: expect.stringContaining('explicit provider/model alias'),
    });
  });

  it('maps timeout to an error result, retries with message-usage fallback on malformed stats, and rejects missing parent env', async () => {
    const timeoutLauncher = new PiSubagentLauncher(
      {
        cli: 'pi-fixture',
        provider: 'anthropic',
        modelAliasesByRole: aliasesByRole({
          reasoning: { mode: 'subscription', model: 'claude-sonnet' },
        }),
        systemPromptPath: '/pkg/context/pi-system-prompt.md',
        adapterExtensionPath: '/adapter/index.ts',
        projectorExtensionPath: '/pkg/dist/integrations/pi/projector.js',
      },
      PARENT_ENV,
      {
        runStreaming: async () => {
          throw Object.assign(new Error('timeout'), { __timeout: true });
        },
        procControl: {
          spawn: vi.fn(),
          kill: vi.fn(),
          setTimeout,
          clearTimeout,
          onExit: vi.fn(),
          offExit: vi.fn(),
        },
        makeTempDir: async () => '/tmp/child',
        writeText: async () => undefined,
        cleanupDir: async () => undefined,
        readText: async () => 'baseline',
      },
    );
    await expect(timeoutLauncher.run(TASK, new AbortController().signal)).resolves.toMatchObject({
      isError: true,
      text: 'subagent timed out',
    });

    const fallbackLauncher = new PiSubagentLauncher(
      {
        cli: 'pi-fixture',
        provider: 'anthropic',
        model: 'claude-sonnet',
        modelAliasesByRole: aliasesByRole({
          reasoning: { mode: 'subscription', model: 'claude-sonnet' },
        }),
        systemPromptPath: '/pkg/context/pi-system-prompt.md',
        adapterExtensionPath: '/adapter/index.ts',
        projectorExtensionPath: '/pkg/dist/integrations/pi/projector.js',
      },
      PARENT_ENV,
      {
        runStreaming: async (input) => {
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
          await input.onStart?.(ctx);
          await input.onRecord(
            JSON.stringify({ type: 'response', id: sent[0]!.id, command: 'prompt', success: true }),
            ctx,
          );
          await input.onRecord(
            JSON.stringify({
              type: 'message_end',
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'fallback' }],
                stopReason: 'stop',
                usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.25 } },
              },
            }),
            ctx,
          );
          await input.onRecord(JSON.stringify({ type: 'agent_settled' }), ctx);
          await input.onRecord(
            JSON.stringify({
              type: 'response',
              id: sent[1]!.id,
              command: 'get_session_stats',
              success: false,
              error: 'no stats',
            }),
            ctx,
          );
          return { stdout: '', stderr: '', code: 0, completed: true };
        },
        procControl: {
          spawn: vi.fn(),
          kill: vi.fn(),
          setTimeout,
          clearTimeout,
          onExit: vi.fn(),
          offExit: vi.fn(),
        },
        makeTempDir: async () => '/tmp/child',
        writeText: async () => undefined,
        cleanupDir: async () => undefined,
        readText: async () => 'baseline',
      },
    );
    await expect(fallbackLauncher.run(TASK, new AbortController().signal)).resolves.toMatchObject({
      isError: false,
      details: { usage: { inputTokens: 1, outputTokens: 2, costUsd: 0.25 } },
    });

    const badLauncher = new PiSubagentLauncher(
      {
        cli: 'pi-fixture',
        provider: 'anthropic',
        modelAliasesByRole: aliasesByRole({
          reasoning: { mode: 'subscription', model: 'claude-sonnet' },
        }),
        systemPromptPath: '/pkg/context/pi-system-prompt.md',
        adapterExtensionPath: '/adapter/index.ts',
        projectorExtensionPath: '/pkg/dist/integrations/pi/projector.js',
      },
      { OPENSQUID_SESSION_ID: '' },
      {
        runStreaming: async () => ({ stdout: '', stderr: '', code: 0, completed: true }),
        procControl: {
          spawn: vi.fn(),
          kill: vi.fn(),
          setTimeout,
          clearTimeout,
          onExit: vi.fn(),
          offExit: vi.fn(),
        },
        makeTempDir: async () => '/tmp/child',
        writeText: async () => undefined,
        cleanupDir: async () => undefined,
        readText: async () => 'baseline',
      },
    );
    await expect(badLauncher.run(TASK, new AbortController().signal)).resolves.toMatchObject({
      isError: true,
    });
  });

  it('does not manufacture behavioral evidence from Pi tool execution records', async () => {
    const launcher = new PiSubagentLauncher(
      {
        cli: 'pi-fixture',
        provider: 'anthropic',
        modelAliasesByRole: aliasesByRole({
          reasoning: { mode: 'subscription', model: 'claude-sonnet' },
        }),
        systemPromptPath: '/pkg/context/pi-system-prompt.md',
        adapterExtensionPath: '/adapter/index.ts',
        projectorExtensionPath: '/pkg/dist/integrations/pi/projector.js',
        childIdFactory: () => 'evidence',
      },
      PARENT_ENV,
      {
        runStreaming: async (input) => {
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
          await input.onStart?.(ctx);
          await input.onRecord(
            JSON.stringify({ type: 'response', id: sent[0]!.id, command: 'prompt', success: true }),
            ctx,
          );
          await input.onRecord(
            JSON.stringify({
              type: 'tool_execution_start',
              toolCallId: 'bash-1',
              toolName: 'bash',
              args: { command: 'chmod 777 .opensquid/tmp/safety-sentinel.txt' },
            }),
            ctx,
          );
          await input.onRecord(
            JSON.stringify({
              type: 'tool_execution_end',
              toolCallId: 'bash-1',
              toolName: 'bash',
              result: {},
              isError: true,
            }),
            ctx,
          );
          await input.onRecord(
            JSON.stringify({
              type: 'tool_execution_start',
              toolCallId: 'write-1',
              toolName: 'write',
              args: { path: 'test/fixtures/child.txt' },
            }),
            ctx,
          );
          await input.onRecord(
            JSON.stringify({
              type: 'tool_execution_end',
              toolCallId: 'write-1',
              toolName: 'write',
              result: {},
              isError: false,
            }),
            ctx,
          );
          await input.onRecord(JSON.stringify({ type: 'agent_settled' }), ctx);
          await input.onRecord(
            JSON.stringify({
              type: 'response',
              id: sent[1]!.id,
              command: 'get_session_stats',
              success: true,
              data: { tokens: { input: 0, output: 0 }, cost: 0 },
            }),
            ctx,
          );
          return { stdout: '', stderr: '', code: 0, completed: true };
        },
        procControl: {
          spawn: vi.fn(),
          kill: vi.fn(),
          setTimeout,
          clearTimeout,
          onExit: vi.fn(),
          offExit: vi.fn(),
        },
        makeTempDir: async () => '/tmp/child',
        writeText: async () => undefined,
        cleanupDir: async () => undefined,
        readText: async () => 'baseline',
      },
    );

    await expect(launcher.run(TASK, new AbortController().signal)).resolves.toMatchObject({
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
  });

  it('runs one stable executor through fresh Pi laps until a strict SHIPPED exit and aggregates every lap', async () => {
    const prompts: string[] = [];
    const executorIds: string[] = [];
    const sessionIds: string[] = [];
    let calls = 0;
    const launcher = new PiSubagentLauncher(
      {
        cli: 'pi-fixture',
        provider: 'anthropic',
        modelAliasesByRole: aliasesByRole({
          reasoning: { mode: 'subscription', model: 'claude-sonnet' },
        }),
        systemPromptPath: '/pkg/context/pi-system-prompt.md',
        adapterExtensionPath: '/adapter/index.ts',
        projectorExtensionPath: '/pkg/dist/integrations/pi/projector.js',
        childIdFactory: () => 'loop-id',
        executorLoop: { maxLaps: 3, backoffMs: 0 },
      },
      PARENT_ENV,
      {
        runStreaming: async (input) => {
          calls += 1;
          executorIds.push(input.env?.OPENSQUID_EXECUTOR_ID ?? '');
          sessionIds.push(input.env?.OPENSQUID_SESSION_ID ?? '');
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
          await input.onStart?.(ctx);
          prompts.push(typeof sent[0]?.message === 'string' ? sent[0].message : '');
          await input.onRecord(
            JSON.stringify({ type: 'response', id: sent[0]!.id, command: 'prompt', success: true }),
            ctx,
          );
          const text =
            calls === 1
              ? 'work persisted, but the typed exit was omitted'
              : 'verified result\nRALPH-EXIT: {"kind":"SHIPPED"}';
          await input.onRecord(
            JSON.stringify({
              type: 'message_end',
              message: {
                role: 'assistant',
                content: [{ type: 'text', text }],
                stopReason: 'stop',
                usage: {
                  input: calls,
                  output: calls,
                  cacheRead: 0,
                  cacheWrite: 0,
                  cost: { total: 0.1 * calls },
                },
              },
            }),
            ctx,
          );
          await input.onRecord(JSON.stringify({ type: 'agent_settled' }), ctx);
          await input.onRecord(
            JSON.stringify({
              type: 'response',
              id: sent[1]!.id,
              command: 'get_session_stats',
              success: true,
              data: {
                tokens: { input: calls, output: calls, cacheRead: 0, cacheWrite: 0 },
                cost: 0.1 * calls,
              },
            }),
            ctx,
          );
          return { stdout: '', stderr: '', code: 0, completed: true };
        },
        procControl: {
          spawn: vi.fn(),
          kill: vi.fn(),
          setTimeout,
          clearTimeout,
          onExit: vi.fn(),
          offExit: vi.fn(),
        },
        makeTempDir: async () => '/tmp/child-loop',
        writeText: async () => undefined,
        cleanupDir: async () => undefined,
        readText: async () => 'baseline',
      },
    );

    await expect(launcher.run(TASK, new AbortController().signal)).resolves.toEqual({
      role: 'scope-architect',
      text: 'verified result',
      isError: false,
      details: {
        usage: {
          version: 1,
          inputTokens: 3,
          outputTokens: 3,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0.30000000000000004,
        },
      },
    });
    expect(calls).toBe(2);
    expect(executorIds).toEqual(['pi-child-loop-id', 'pi-child-loop-id']);
    expect(sessionIds).toHaveLength(2);
    expect(sessionIds[0]).toMatch(/^pi-child-loop-id-lap-1-/u);
    expect(sessionIds[1]).toMatch(/^pi-child-loop-id-lap-2-/u);
    expect(sessionIds[0]).not.toBe(sessionIds[1]);
    expect(prompts[0]).toContain('lap 1');
    expect(prompts[1]).toContain('lap 2');
    expect(prompts.every((prompt) => prompt.includes(TASK.task))).toBe(true);
  });

  it('aggregates child usage, truncates detail copies, rejects unknown aliases, and only requests graceful shutdown automatically', async () => {
    const childResults = [
      {
        role: 'a',
        text: 'x',
        isError: false,
        details: {
          usage: {
            version: 1,
            inputTokens: 1,
            outputTokens: 2,
            cacheReadTokens: 3,
            cacheWriteTokens: 4,
            costUsd: 0,
          },
        },
      },
      {
        role: 'b',
        text: 'y',
        isError: true,
        details: {
          usage: {
            version: 1,
            inputTokens: 10,
            outputTokens: 20,
            cacheReadTokens: 30,
            cacheWriteTokens: 40,
            costUsd: 0.5,
          },
        },
      },
    ] as const;
    expect(usageFromResults(childResults)).toEqual({
      version: 1,
      inputTokens: 11,
      outputTokens: 22,
      cacheReadTokens: 33,
      cacheWriteTokens: 44,
      costUsd: 0.5,
    });
    const detailCopy = spawnSubagentDetails({
      results: [{ role: 'a', text: 'x'.repeat(20_000), isError: false }],
      usage: {
        version: 1,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
      },
    });
    expect(detailCopy.results[0]?.text.length).toBeLessThan(20_000);

    const unknownAliasLauncher = new PiSubagentLauncher(
      {
        cli: 'pi-fixture',
        provider: 'anthropic',
        model: 'claude-sonnet',
        modelAliasesByRole: new Map(),
        systemPromptPath: '/pkg/context/pi-system-prompt.md',
        adapterExtensionPath: '/adapter/index.ts',
        projectorExtensionPath: '/pkg/dist/integrations/pi/projector.js',
      },
      PARENT_ENV,
      {
        runStreaming: async () => ({ stdout: '', stderr: '', code: 0, completed: true }),
        procControl: {
          spawn: vi.fn(),
          kill: vi.fn(),
          setTimeout,
          clearTimeout,
          onExit: vi.fn(),
          offExit: vi.fn(),
        },
        makeTempDir: async () => '/tmp/child',
        writeText: async () => undefined,
        cleanupDir: async () => undefined,
        readText: async () => 'baseline',
      },
    );
    const roleWithoutModels = { ...TASK.role };
    delete roleWithoutModels.packModels;
    await expect(
      unknownAliasLauncher.run(
        { ...TASK, role: { ...roleWithoutModels, model: 'unknown-alias' } },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      isError: true,
      text: expect.stringContaining('Unknown model alias'),
    });

    class FakeChild extends EventEmitter {
      pid = 777;
      stdout = new EventEmitter();
      stderr = new EventEmitter();
      stdin = {
        write: () => true,
        end: vi.fn(() => undefined),
        on: () => undefined,
        once: () => undefined,
        removeListener: () => undefined,
      };
      kill(): boolean {
        return true;
      }
    }
    const child = new FakeChild();
    const kills: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
    const procControl: ProcControl = {
      spawn: vi.fn(() => child as never),
      kill: (pid, signal) => {
        kills.push({ pid, signal });
      },
      setTimeout,
      clearTimeout,
      onExit: vi.fn(),
      offExit: vi.fn(),
    };
    const controller = new AbortController();
    const launcher = new PiSubagentLauncher(
      {
        cli: 'pi-fixture',
        provider: 'anthropic',
        modelAliasesByRole: aliasesByRole({
          reasoning: { mode: 'subscription', model: 'claude-sonnet' },
        }),
        systemPromptPath: '/pkg/context/pi-system-prompt.md',
        adapterExtensionPath: '/adapter/index.ts',
        projectorExtensionPath: '/pkg/dist/integrations/pi/projector.js',
      },
      PARENT_ENV,
      {
        runStreaming: async (input) => {
          input.procControl?.spawn('pi-fixture', [], {
            cwd: '/repo',
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          controller.abort();
          child.emit('close', 0);
          throw new SubagentAbortError();
        },
        procControl,
        makeTempDir: async () => '/tmp/child',
        writeText: async () => undefined,
        cleanupDir: async () => undefined,
        readText: async () => 'baseline',
      },
    );
    await expect(launcher.run(TASK, controller.signal)).rejects.toBeInstanceOf(SubagentAbortError);
    expect(child.stdin.end).toHaveBeenCalledTimes(1);
    expect(kills).toEqual([]);
  });
});
