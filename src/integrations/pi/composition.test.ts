import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RalphConfigFile } from '../../setup/wizard/ralph_writer.js';
import { buildRalphConfig, makeSpawnLap } from '../../setup/cli/ralph.js';
import type { Issue } from '../../workgraph/types.js';
import type {
  StreamingCliOptions,
  StreamingCliResult,
  StreamingRecordContext,
  TerminalDecision,
} from '../../runtime/streaming_cli.js';
import { isExternalConsultTool } from '../../runtime/loop/external_consult.js';
import { canonicalizePiToolCall } from './canonicalize.js';
import {
  PI_STAGE_TOOL_CATALOG,
  createDefaultPiHarnessRuntimeAssets,
  OPENSQUID_PACKAGE_ROOT,
  type PiRuntimeDeps,
} from './runtime.js';
import { enabledPiOptionalTools, mcpDirectTools, stagePiTools } from './capability_catalog.js';
import { buildExpectedPiMcpConfig, computePiServerHash } from './mcp_config.js';

interface StreamingDriver {
  readonly records: readonly (Record<string, unknown> | string)[];
  readonly sent: Record<string, unknown>[];
  options?: StreamingCliOptions;
}

function streamingDriver(driver: StreamingDriver) {
  return async (options: StreamingCliOptions): Promise<StreamingCliResult> => {
    driver.options = options;
    let completed = false;
    const ctx: StreamingRecordContext = {
      send: (line) => {
        const parsed = JSON.parse(line) as unknown;
        if (parsed === null || typeof parsed !== 'object') {
          throw new Error('expected JSON object record');
        }
        driver.sent.push(parsed as Record<string, unknown>);
        return Promise.resolve();
      },
      complete: () => {
        completed = true;
      },
      fail: (error) => {
        throw error;
      },
    };
    await options.onStart?.(ctx);
    for (const fixture of driver.records) {
      const record = typeof fixture === 'string' ? fixture : JSON.stringify(fixture);
      const decision: TerminalDecision = await options.onRecord(record, ctx);
      if (typeof decision === 'object') throw decision.fail;
      if (decision === 'complete') completed = true;
    }
    return { stdout: '', stderr: '', code: 0, completed };
  };
}

function expectedStageCatalog(): string[] {
  return stagePiTools(enabledPiOptionalTools());
}

const ITEM: Issue = {
  id: 'wg-pi-composition',
  title: 'Pi composition item',
  body: 'exercise the live StageProcess composition',
  status: 'open',
  createdAt: '2026-07-11T00:00:00.000Z',
  updatedAt: '2026-07-11T00:00:00.000Z',
};

describe('Pi harness production composition', () => {
  let dir = '';

  afterEach(async () => {
    if (dir !== '') await rm(dir, { recursive: true, force: true });
  });

  it('orders readiness before the StageProcess spawn and folds the real Pi runtime surfaces through makeSpawnLap', async () => {
    dir = await mkdtemp(join(tmpdir(), 'opensquid-pi-composition-'));
    const ralphMdPath = join(dir, 'RALPH.md');
    await writeFile(
      ralphMdPath,
      'You are the StageProcess harness under test. Emit one valid exit.\n',
      'utf8',
    );

    const order: string[] = [];
    const stageCatalog = expectedStageCatalog();
    const driver: StreamingDriver = {
      sent: [],
      records: [
        {
          type: 'response',
          id: 'opensquid-prompt-fixed-attempt',
          command: 'prompt',
          success: true,
        },
        {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'done\n' },
              { type: 'text', text: 'RALPH-EXIT: {"kind":"SHIPPED"}' },
            ],
            stopReason: 'stop',
            usage: { input: 1, output: 2, cost: { total: 0.1 } },
          },
        },
        { type: 'agent_settled' },
        {
          type: 'response',
          id: 'opensquid-stats-fixed-attempt',
          command: 'get_session_stats',
          success: true,
          data: { tokens: { input: 10, output: 20, cacheRead: 2, cacheWrite: 3 }, cost: 0.2 },
        },
      ],
    };

    const runtimeDeps: PiRuntimeDeps = {
      ensurePiMcpReady: vi.fn(() => {
        order.push('mcp');
        return Promise.resolve({
          adapterEntry: '/verified/pi-mcp-adapter/index.js',
          adapterVersion: '6.1.0',
          configHash: 'c'.repeat(64),
          cacheHash: 'c'.repeat(64),
          mcpTools: new Set(mcpDirectTools(enabledPiOptionalTools())),
        });
      }),
      probePiStageRuntime: vi.fn((input: Parameters<PiRuntimeDeps['probePiStageRuntime']>[0]) => {
        order.push('full');
        expect(input.stageTools).toEqual(stageCatalog);
        return Promise.resolve({
          registeredTools: new Set(stageCatalog),
          activeTools: new Set(stageCatalog),
        });
      }),
      getAvailablePiProviders: vi.fn(() => {
        order.push('providers');
        return Promise.resolve(new Map([['openai-codex', new Set(['gpt-5.6-sol'])]]));
      }),
      getResolvedPiModel: vi.fn(() => {
        order.push('resolved-model');
        return Promise.resolve({ provider: 'openai-codex', id: 'gpt-5.6-sol' });
      }),
      readPiVersion: vi.fn(() => {
        order.push('version');
        return Promise.resolve('9.7.3');
      }),
      loadEffectivePiShellSettings: vi.fn(() => {
        order.push('settings');
        return Promise.resolve({});
      }),
    };
    const runtimeAssets = createDefaultPiHarnessRuntimeAssets({ env: { HOME: dir } }, runtimeDeps);

    expect(runtimeAssets.stageTools).toEqual(stageCatalog);
    expect(runtimeAssets.stageTools).not.toContain('spawn_subagent');
    expect(PI_STAGE_TOOL_CATALOG.map((tool) => tool.name)).toEqual([
      'read',
      'bash',
      'grep',
      'edit',
      'write',
      'workgraph_get',
      'recall',
      'read_state',
      'web_fetch',
      'decision_classify',
      'log_phase',
      'workgraph_create_issue',
      'workgraph_add_edge',
      'workgraph_update_issue',
      'store_lesson',
      'set_loop_phase',
    ]);

    const file: RalphConfigFile = {
      authMode: 'subscription',
      maxBudgetUsd: 10,
      claimTtlSec: 3600,
      idleTimeoutMs: 1000,
      maxRetries: 0,
      backoffBaseMs: 50,
      harness: {
        kind: 'pi',
        cli: 'pi-fixture',
        ralphMdPath,
      },
    };
    const cfg = buildRalphConfig(file, { runId: 'pi-composition' });

    const result = await makeSpawnLap(cfg, file, vi.fn(), {
      runStreaming: async (options) => {
        order.push('spawn');
        return streamingDriver(driver)(options);
      },
      assets: { pi: runtimeAssets },
      attemptId: () => 'fixed-attempt',
    })(ITEM);

    expect(order).toEqual([
      'mcp',
      'full',
      'providers',
      'resolved-model',
      'version',
      'settings',
      'spawn',
    ]);
    expect(result).toMatchObject({ kind: 'SHIPPED', inputTokens: 10, outputTokens: 20 });
    expect(result.costUsd).toBeCloseTo(0.2, 8);
    expect(driver.sent).toEqual([
      expect.objectContaining({
        type: 'prompt',
        id: 'opensquid-prompt-fixed-attempt',
      }),
      { id: 'opensquid-stats-fixed-attempt', type: 'get_session_stats' },
    ]);
    expect(driver.sent[0]?.message).toContain('Your assigned work-item id: wg-pi-composition');
    expect(driver.options?.args).toContain('--tools');
    expect(driver.options?.args.at(-1)).toBe(stageCatalog.join(','));
    expect(driver.options?.env).toMatchObject({
      OPENSQUID_ITEM_ID: ITEM.id,
      OPENSQUID_SESSION_ID: 'fixed-attempt',
      OPENSQUID_AUTOMATION: '1',
      OPENSQUID_LOOP_LAP: '1',
      OPENSQUID_PI_CLI: 'pi-fixture',
    });
  });

  it('keeps the authoritative MCP config/cache hash static across lap env changes and recognizes canonical web_fetch but not Bash curl', async () => {
    const configA = buildExpectedPiMcpConfig({
      path: '/tmp/pi/mcp.json',
      opensquidRoot: OPENSQUID_PACKAGE_ROOT,
    });
    const configB = buildExpectedPiMcpConfig({
      path: '/tmp/pi/mcp.json',
      opensquidRoot: OPENSQUID_PACKAGE_ROOT,
    });

    expect(configA.raw.mcpServers.opensquid.env).toEqual({});
    expect(configA.raw.mcpServers.opensquid.args?.[0]).not.toContain('//dist/');
    expect(configA.raw).toEqual(configB.raw);
    expect(configA.hash).toBe(configB.hash);
    expect(
      computePiServerHash(configA.raw.mcpServers.opensquid, {
        OPENSQUID_SESSION_ID: 'lap-a',
        OPENSQUID_ITEM_ID: 'wg-a',
      }),
    ).toBe(
      computePiServerHash(configA.raw.mcpServers.opensquid, {
        OPENSQUID_SESSION_ID: 'lap-b',
        OPENSQUID_ITEM_ID: 'wg-b',
      }),
    );

    const webFetch = await canonicalizePiToolCall(
      {
        type: 'tool_call',
        toolCallId: 'wf-1',
        toolName: 'web_fetch',
        input: { url: 'https://example.com/spec' },
      } as never,
      '/repo',
    );
    const bashCurl = await canonicalizePiToolCall(
      {
        type: 'tool_call',
        toolCallId: 'sh-1',
        toolName: 'bash',
        input: { command: 'curl https://example.com/spec -o fixture.txt' },
      } as never,
      '/repo',
    );

    expect(webFetch.tool).toBe('mcp__opensquid__web_fetch');
    expect(isExternalConsultTool(webFetch.tool)).toBe(true);
    expect(bashCurl.tool).toBe('Bash');
    expect(isExternalConsultTool(bashCurl.tool)).toBe(false);
  });
});
