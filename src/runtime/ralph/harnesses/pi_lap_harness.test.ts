import { describe, expect, it, vi } from 'vitest';
import { piLapHarness } from './pi_lap_harness.js';
import type {
  LapRequest,
  LapRuntimeDeps,
  PiHarnessConfig,
  PiHarnessRuntimeAssets,
  VerifiedPiRuntime,
} from '../lap_harness.js';
import type {
  StreamingCliOptions,
  StreamingCliResult,
  StreamingRecordContext,
  TerminalDecision,
  runStreamingCli,
} from '../../streaming_cli.js';

const CONFIG: PiHarnessConfig = {
  kind: 'pi',
  cli: 'pi-fixture',
  ralphMdPath: '/ralph',
  maxBudgetUsd: 10,
};
const REQUEST: LapRequest = {
  prompt: 'do work',
  cwd: '/repo',
  timeoutMs: 1000,
  env: { OPENSQUID_ITEM_ID: 'wg-1' },
  attemptId: 'attempt-1',
};
const EVIDENCE: VerifiedPiRuntime = {
  piVersion: '9.7.3',
  mcpAdapterVersion: '4.6.2',
  providers: new Map([['anthropic', new Set(['model-a'])]]),
  resolvedModel: { provider: 'anthropic', id: 'model-a' },
  registeredTools: new Set(['read', 'workgraph_get']),
  activeTools: new Set(['read', 'workgraph_get']),
  genericProxyAbsent: true,
  effectiveShell: { commandPrefix: 'source env.sh', shellPath: '/bin/zsh' },
};
const assets = (evidence: VerifiedPiRuntime = EVIDENCE): PiHarnessRuntimeAssets => ({
  systemPromptPath: '/pkg/context/pi-system-prompt.md',
  mcpAdapterExtensionPath: '/verified/pi-mcp-adapter/index.js',
  projectorExtensionPath: '/pkg/dist/integrations/pi/projector.js',
  stageTools: ['read', 'workgraph_get'],
  statsTimeoutMs: 5,
  readiness: vi.fn(() => Promise.resolve(evidence)),
});

interface Driver {
  records: (Record<string, unknown> | string)[];
  afterRecord?: (
    record: Record<string, unknown>,
    ctx: StreamingRecordContext,
  ) => Promise<void> | void;
  sent: Record<string, unknown>[];
  options?: StreamingCliOptions;
}
function streamingDriver(driver: Driver): typeof runStreamingCli {
  return async (options: StreamingCliOptions): Promise<StreamingCliResult> => {
    driver.options = options;
    let completed = false;
    const ctx: StreamingRecordContext = {
      send: (line) => {
        const parsed: unknown = JSON.parse(line);
        if (parsed === null || typeof parsed !== 'object') throw new Error('expected record');
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
      if (typeof fixture !== 'string') await driver.afterRecord?.(fixture, ctx);
    }
    return { stdout: '', stderr: '', code: 0, completed };
  };
}
function deps(driver: Driver, runtimeAssets = assets()): LapRuntimeDeps {
  return {
    runOneShot: vi.fn(),
    runStreaming: streamingDriver(driver),
    assets: { pi: runtimeAssets },
  };
}
const assistant = (overrides: Record<string, unknown> = {}) => ({
  type: 'message_end',
  message: {
    role: 'assistant',
    content: [
      { type: 'text', text: 'A' },
      { type: 'thinking', thinking: 'x' },
      { type: 'text', text: 'B' },
    ],
    stopReason: 'stop',
    usage: { input: 3, output: 4, cost: { total: 0.25 } },
    ...overrides,
  },
});
const accepted = {
  type: 'response',
  id: 'opensquid-prompt-attempt-1',
  command: 'prompt',
  success: true,
};
const stats = (cost: unknown = 0) => ({
  type: 'response',
  id: 'opensquid-stats-attempt-1',
  command: 'get_session_stats',
  success: true,
  data: { tokens: { input: 10, output: 20, cacheRead: 2, cacheWrite: 3 }, cost },
});

describe('Pi preflight and invocation', () => {
  it('requires behavioral readiness and hands effective shell metadata through request.env', async () => {
    const driver: Driver = { records: [], sent: [] };
    const runtimeAssets = assets();
    const request: LapRequest = { ...REQUEST, env: { ...REQUEST.env } };
    await expect(
      piLapHarness.preflight?.(CONFIG, deps(driver, runtimeAssets), request),
    ).resolves.toBeUndefined();
    expect(runtimeAssets.readiness).toHaveBeenCalledWith({
      cli: 'pi-fixture',
      cwd: '/repo',
      env: request.env,
      attemptId: 'attempt-1',
    });
    expect(request.env).toMatchObject({
      OPENSQUID_PI_SHELL_COMMAND_PREFIX: 'source env.sh',
      OPENSQUID_PI_SHELL_PATH: '/bin/zsh',
    });

    for (const bad of [
      { ...EVIDENCE, genericProxyAbsent: false },
      { ...EVIDENCE, registeredTools: new Set(['read']) },
      { ...EVIDENCE, activeTools: new Set(['read']) },
    ]) {
      await expect(
        piLapHarness.preflight?.(CONFIG, deps(driver, assets(bad)), REQUEST),
      ).rejects.toThrow();
    }
  });

  it('uses isolated StageProcess flags, exact extensions/tools, and keeps context files enabled', () => {
    const args = piLapHarness.spawnArgs(CONFIG, assets());
    expect(args).toEqual([
      '--mode',
      'rpc',
      '--no-approve',
      '--no-session',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
      '--system-prompt',
      '/pkg/context/pi-system-prompt.md',
      '--append-system-prompt',
      '',
      '-e',
      '/verified/pi-mcp-adapter/index.js',
      '-e',
      '/pkg/dist/integrations/pi/projector.js',
      '--tools',
      'read,workgraph_get',
    ]);
    expect(args).not.toContain('--no-context-files');
  });
});

describe('Pi RPC fold and settlement', () => {
  it('correlates prompt/stats, waits for settlement, concatenates last text blocks, and native zero wins', async () => {
    const driver: Driver = {
      records: [accepted, assistant(), { type: 'agent_settled' }, stats(0)],
      sent: [],
    };
    const env = await piLapHarness.run(REQUEST, CONFIG, deps(driver));
    expect(env).toEqual({
      resultText: 'AB',
      costUsd: 0,
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 2,
      cacheWriteTokens: 3,
      isError: false,
    });
    expect(driver.sent).toEqual([
      { id: 'opensquid-prompt-attempt-1', type: 'prompt', message: 'do work' },
      { id: 'opensquid-stats-attempt-1', type: 'get_session_stats' },
    ]);
  });

  it('treats agent_settled as final after Pi has drained queued continuations', async () => {
    const driver: Driver = {
      records: [
        accepted,
        { type: 'queue_update', steering: ['continue'], followUp: [] },
        { type: 'agent_settled' },
        stats(1),
      ],
      sent: [],
    };
    const env = await piLapHarness.run(REQUEST, CONFIG, deps(driver));
    expect(env.isError).toBe(false);
    expect(driver.sent.filter((r) => r.type === 'get_session_stats')).toHaveLength(1);
  });

  it('falls back from failed or malformed statistics to summed message usage', async () => {
    for (const statsResponse of [
      { ...stats(), success: false, error: 'no stats' },
      stats('not-a-number'),
    ]) {
      const driver: Driver = {
        records: [accepted, assistant(), { type: 'agent_settled' }, statsResponse],
        sent: [],
      };
      await expect(piLapHarness.run(REQUEST, CONFIG, deps(driver))).resolves.toMatchObject({
        costUsd: 0.25,
        inputTokens: 3,
        outputTokens: 4,
        isError: false,
      });
    }
  });

  it('times out only the statistics query, closes input, and uses message fallback', async () => {
    const runtimeAssets = { ...assets(), statsTimeoutMs: 1 };
    const runStreaming: typeof runStreamingCli = async (
      options: StreamingCliOptions,
    ): Promise<StreamingCliResult> => {
      let release!: () => void;
      const closed = new Promise<void>((resolve) => {
        release = resolve;
      });
      const context: StreamingRecordContext = {
        send: () => Promise.resolve(),
        complete: release,
        fail: (error) => {
          throw error;
        },
      };
      await options.onStart?.(context);
      await options.onRecord(JSON.stringify(accepted), context);
      await options.onRecord(JSON.stringify(assistant()), context);
      await options.onRecord(JSON.stringify({ type: 'agent_settled' }), context);
      await closed;
      return { stdout: '', stderr: '', code: 0, completed: true };
    };
    const runtimeDeps: LapRuntimeDeps = {
      runOneShot: vi.fn(),
      runStreaming,
      assets: { pi: runtimeAssets },
    };
    await expect(piLapHarness.run(REQUEST, CONFIG, runtimeDeps)).resolves.toMatchObject({
      costUsd: 0.25,
      inputTokens: 3,
      outputTokens: 4,
      isError: false,
    });
  });

  it('does not synthesize model pricing when Pi reports no native cost', async () => {
    const noNative = assistant({ usage: { input: 1_000_000, output: 500_000, cost: {} } });
    const driver: Driver = {
      records: [accepted, noNative, { type: 'agent_settled' }, stats('bad')],
      sent: [],
    };
    await expect(piLapHarness.run(REQUEST, CONFIG, deps(driver))).resolves.toMatchObject({
      costUsd: 0,
    });
  });

  it('fails closed on malformed JSONL, missing settlement, extension error, and terminal stop reasons', async () => {
    const malformed: Driver = { records: [accepted, '{bad'], sent: [] };
    await expect(piLapHarness.run(REQUEST, CONFIG, deps(malformed))).resolves.toMatchObject({
      isError: true,
    });

    const missing: Driver = { records: [accepted, assistant()], sent: [] };
    await expect(piLapHarness.run(REQUEST, CONFIG, deps(missing))).resolves.toMatchObject({
      isError: true,
    });

    for (const reason of ['length', 'error', 'aborted']) {
      const driver: Driver = {
        records: [
          accepted,
          assistant({ stopReason: reason }),
          { type: 'extension_error' },
          { type: 'agent_settled' },
          stats(),
        ],
        sent: [],
      };
      await expect(piLapHarness.run(REQUEST, CONFIG, deps(driver))).resolves.toMatchObject({
        isError: true,
      });
    }
    const toolUse: Driver = {
      records: [accepted, assistant({ stopReason: 'toolUse' }), { type: 'agent_settled' }, stats()],
      sent: [],
    };
    await expect(piLapHarness.run(REQUEST, CONFIG, deps(toolUse))).resolves.toMatchObject({
      isError: false,
    });
  });

  it('treats correlated prompt rejection as a protocol error envelope', async () => {
    const driver: Driver = {
      records: [{ ...accepted, success: false, error: 'rejected' }],
      sent: [],
    };
    await expect(piLapHarness.run(REQUEST, CONFIG, deps(driver))).resolves.toMatchObject({
      isError: true,
    });
  });
});
