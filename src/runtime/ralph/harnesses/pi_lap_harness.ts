/** Pi RPC lap adapter. All Pi flags and model-driven wire semantics remain in the Pi vendor layer. */
import type {
  LapEnvelope,
  LapHarness,
  PiHarnessConfig,
  PiHarnessRuntimeAssets,
  VerifiedPiRuntime,
} from '../lap_harness.js';
import {
  PI_READINESS_PROBE_ENV,
  PI_SHELL_COMMAND_PREFIX_ENV,
  PI_SHELL_PATH_ENV,
} from '../../../integrations/pi/env.js';
import { runPiRpcAgentSession } from '../../../integrations/pi/rpc_agent_session.js';
import {
  controlledOwnedProcess,
  listOwnedProcesses,
  ProcessPausedError,
  type ProcessShutdownCause,
} from '../../processes/process_control.js';
import { realProcControl } from '../../spawn_lifecycle.js';
function assertAssets(assets: PiHarnessRuntimeAssets | null): PiHarnessRuntimeAssets {
  if (assets === null) {
    throw new Error('Pi runtime assets are not composed; run Pi setup/readiness before the lap');
  }
  for (const [name, value] of Object.entries({
    systemPromptPath: assets.systemPromptPath,
    mcpAdapterExtensionPath: assets.mcpAdapterExtensionPath,
    projectorExtensionPath: assets.projectorExtensionPath,
  })) {
    if (value.trim() === '') throw new Error(`Pi runtime asset ${name} is empty`);
  }
  if (
    assets.stageTools.length === 0 ||
    new Set(assets.stageTools).size !== assets.stageTools.length
  ) {
    throw new Error('Pi StageProcess tool allowlist must be non-empty and duplicate-free');
  }
  return assets;
}

function assertReadiness(
  evidence: VerifiedPiRuntime,
  config: PiHarnessConfig,
  assets: PiHarnessRuntimeAssets,
): VerifiedPiRuntime {
  const models = evidence.providers.get(evidence.resolvedModel.provider);
  if (models === undefined) {
    throw new Error(`Pi resolved provider is unavailable: ${evidence.resolvedModel.provider}`);
  }
  if (models !== null && !models.has(evidence.resolvedModel.id)) {
    throw new Error(
      `Pi resolved model is unavailable for provider ${evidence.resolvedModel.provider}: ${evidence.resolvedModel.id}`,
    );
  }
  if (!evidence.genericProxyAbsent) {
    throw new Error('Pi generic MCP proxy must be absent before model execution');
  }
  const missingRegistered = assets.stageTools.filter((tool) => !evidence.registeredTools.has(tool));
  if (missingRegistered.length > 0) {
    throw new Error(`Pi StageProcess tools are not registered: ${missingRegistered.join(', ')}`);
  }
  const missingActive = assets.stageTools.filter((tool) => !evidence.activeTools.has(tool));
  if (missingActive.length > 0) {
    throw new Error(`Pi StageProcess tools are not active: ${missingActive.join(', ')}`);
  }
  return evidence;
}

async function durableStageHumanCause(
  processId: string,
  processInstanceId: string,
): Promise<Extract<ProcessShutdownCause, { kind: 'human' }> | undefined> {
  const state = (await listOwnedProcesses()).find(
    (candidate) =>
      candidate.processId === processId && candidate.processInstanceId === processInstanceId,
  );
  const action = state?.latestAction;
  if (
    action === undefined ||
    action.action === 'resume' ||
    (action.appliedAtMs === undefined &&
      state?.status !== 'shutdown_requested' &&
      state?.status !== 'terminate_requested' &&
      state?.status !== 'force_kill_requested' &&
      state?.status !== 'paused')
  ) {
    return undefined;
  }
  return {
    kind: 'human',
    action: action.action,
    requestedBy: action.requestedBy,
    authorizedBy: action.authorizedBy,
    actionId: action.actionId,
  };
}

function spawnArgs(_config: PiHarnessConfig, assets: PiHarnessRuntimeAssets): string[] {
  return [
    '--mode',
    'rpc',
    '--no-approve',
    '--no-session',
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
    '--system-prompt',
    assets.systemPromptPath,
    '--append-system-prompt',
    '',
    '-e',
    assets.mcpAdapterExtensionPath,
    '-e',
    assets.projectorExtensionPath,
    '--tools',
    assets.stageTools.join(','),
  ];
}

export const piLapHarness: LapHarness<PiHarnessConfig> & {
  spawnArgs(config: PiHarnessConfig, assets: PiHarnessRuntimeAssets): string[];
} = {
  kind: 'pi',
  spawnArgs,
  async preflight(config, deps, request): Promise<void> {
    const assets = assertAssets(deps.assets.pi);
    const evidence = assertReadiness(
      await assets.readiness({
        cli: config.cli,
        cwd: request.cwd,
        env: request.env,
        attemptId: request.attemptId,
      }),
      config,
      assets,
    );
    if (evidence.effectiveShell.commandPrefix === undefined) {
      delete request.env[PI_SHELL_COMMAND_PREFIX_ENV];
    } else {
      request.env[PI_SHELL_COMMAND_PREFIX_ENV] = evidence.effectiveShell.commandPrefix;
    }
    if (evidence.effectiveShell.shellPath === undefined) {
      delete request.env[PI_SHELL_PATH_ENV];
    } else {
      request.env[PI_SHELL_PATH_ENV] = evidence.effectiveShell.shellPath;
    }
  },
  async run(request, config, deps): Promise<LapEnvelope> {
    const assets = assertAssets(deps.assets.pi);
    const stageProcessId = `pi-stage-${request.attemptId}`;
    const stageControl = controlledOwnedProcess({
      processId: stageProcessId,
      wgId: request.env.OPENSQUID_ITEM_ID ?? 'unknown',
      ...(request.env.OPENSQUID_RUN_ID === undefined
        ? {}
        : { runId: request.env.OPENSQUID_RUN_ID }),
      ...(request.env.OPENSQUID_CHECKPOINT_STAGE === undefined
        ? {}
        : { checkpointStage: request.env.OPENSQUID_CHECKPOINT_STAGE }),
      lap: 1,
      role: 'stage-process',
      ownership: 'control_root',
      base: realProcControl,
    });
    let stageSession;
    try {
      stageSession = await runPiRpcAgentSession({
        runStreaming: deps.runStreaming,
        transport: {
          cli: config.cli,
          args: spawnArgs(config, assets),
          cwd: request.cwd,
          env: { ...request.env, [PI_READINESS_PROBE_ENV]: '0' },
          timeoutMs: request.timeoutMs,
          processGroup: 'own',
          onShutdownRequested: () => stageControl.markAutomaticShutdown(),
          procControl: stageControl.procControl,
          ...(request.onStderrLine === undefined ? {} : { onStderrLine: request.onStderrLine }),
          ...(request.onStreams === undefined ? {} : { onStreams: request.onStreams }),
        },
        prompt: request.prompt,
        promptId: `opensquid-prompt-${request.attemptId}`,
        statsId: `opensquid-stats-${request.attemptId}`,
        ...(assets.statsTimeoutMs === undefined ? {} : { statsTimeoutMs: assets.statsTimeoutMs }),
      });
    } catch (error) {
      const localCause = stageControl.shutdownCause();
      const cause =
        localCause?.kind === 'human'
          ? localCause
          : await durableStageHumanCause(stageProcessId, stageControl.processInstanceId).catch(
              () => undefined,
            );
      if (cause !== undefined) throw new ProcessPausedError(stageProcessId, cause);
      throw error;
    } finally {
      stageControl.dispose();
    }
    const localSettledCause = stageControl.shutdownCause();
    const settledCause =
      localSettledCause?.kind === 'human'
        ? localSettledCause
        : await durableStageHumanCause(stageProcessId, stageControl.processInstanceId).catch(
            () => undefined,
          );
    if (settledCause !== undefined) {
      throw new ProcessPausedError(stageProcessId, settledCause);
    }

    const stageCost = stageSession.hasNativeCost ? stageSession.usage.costUsd : 0;
    return {
      resultText: stageSession.text,
      costUsd: stageCost,
      inputTokens: stageSession.usage.inputTokens,
      outputTokens: stageSession.usage.outputTokens,
      cacheReadTokens: stageSession.usage.cacheReadTokens,
      cacheWriteTokens: stageSession.usage.cacheWriteTokens,
      isError: stageSession.isError,
    };
  },
};
