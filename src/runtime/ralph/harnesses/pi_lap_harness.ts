/** Pi RPC lap adapter. All Pi flags and model-driven wire semantics remain in the Pi vendor layer. */
import { isAbsolute } from 'node:path';

import type {
  LapEnvelope,
  LapHarness,
  PiHarnessConfig,
  PiHarnessRuntimeAssets,
  VerifiedPiRuntime,
} from '../lap_harness.js';
import {
  PI_READINESS_PROBE_ENV,
  PI_ROLE_MANIFEST_HASH_ENV,
  PI_ROLE_MANIFEST_PATH_ENV,
  PI_SHELL_COMMAND_PREFIX_ENV,
  PI_SHELL_PATH_ENV,
  isSha256Hex,
} from '../../../integrations/pi/env.js';
import { runPiRpcAgentSession } from '../../../integrations/pi/rpc_agent_session.js';
import {
  controlledExecutorProcess,
  listExecutorProcesses,
  ProcessPausedError,
  type ProcessShutdownCause,
} from '../../subagents/process_control.js';
import { realProcControl } from '../../spawn_lifecycle.js';
import {
  decodeSubagentControlOutcome,
  decodeSubagentUsage,
} from '../../../integrations/pi/subagent_usage.js';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function assertAssets(assets: PiHarnessRuntimeAssets | null): PiHarnessRuntimeAssets {
  if (assets === null) {
    throw new Error('Pi runtime assets are not composed; run Pi setup/readiness before the lap');
  }
  for (const [name, value] of Object.entries({
    systemPromptPath: assets.systemPromptPath,
    mcpAdapterExtensionPath: assets.mcpAdapterExtensionPath,
    projectorExtensionPath: assets.projectorExtensionPath,
    spawnSubagentExtensionPath: assets.spawnSubagentExtensionPath,
  })) {
    if (value.trim() === '') throw new Error(`Pi runtime asset ${name} is empty`);
  }
  if (
    assets.parentTools.length === 0 ||
    new Set(assets.parentTools).size !== assets.parentTools.length
  ) {
    throw new Error('Pi parent tool allowlist must be non-empty and duplicate-free');
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
  const missingRegistered = assets.parentTools.filter(
    (tool) => !evidence.registeredTools.has(tool),
  );
  if (missingRegistered.length > 0) {
    throw new Error(`Pi parent tools are not registered: ${missingRegistered.join(', ')}`);
  }
  const missingActive = assets.parentTools.filter((tool) => !evidence.activeTools.has(tool));
  if (missingActive.length > 0) {
    throw new Error(`Pi parent tools are not active: ${missingActive.join(', ')}`);
  }
  if (!isAbsolute(evidence.roleManifestPath)) {
    throw new Error('Pi role manifest path must be absolute');
  }
  if (!isSha256Hex(evidence.roleManifestHash)) {
    throw new Error('Pi role manifest hash must be a 64-char sha256 hex');
  }
  return evidence;
}

async function durableParentHumanCause(
  executorId: string,
  processInstanceId: string,
): Promise<Extract<ProcessShutdownCause, { kind: 'human' }> | undefined> {
  const state = (await listExecutorProcesses()).find(
    (candidate) =>
      candidate.executorId === executorId && candidate.processInstanceId === processInstanceId,
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
    '-e',
    assets.spawnSubagentExtensionPath,
    '--tools',
    assets.parentTools.join(','),
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
    request.env[PI_ROLE_MANIFEST_PATH_ENV] = evidence.roleManifestPath;
    request.env[PI_ROLE_MANIFEST_HASH_ENV] = evidence.roleManifestHash;
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
    const childUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
    };
    const childSeen = new Set<string>();
    let childControlOutcome: ReturnType<typeof decodeSubagentControlOutcome> = null;
    const parentExecutorId = `pi-parent-${request.attemptId}`;
    const parentControl = controlledExecutorProcess({
      executorId: parentExecutorId,
      wgId: request.env.OPENSQUID_ITEM_ID ?? 'unknown',
      ...(request.env.OPENSQUID_RUN_ID === undefined
        ? {}
        : { runId: request.env.OPENSQUID_RUN_ID }),
      ...(request.env.OPENSQUID_CHECKPOINT_STAGE === undefined
        ? {}
        : { checkpointStage: request.env.OPENSQUID_CHECKPOINT_STAGE }),
      lap: 1,
      role: 'orchestrator',
      base: realProcControl,
    });
    let parent;
    try {
      parent = await runPiRpcAgentSession({
        runStreaming: deps.runStreaming,
        transport: {
          cli: config.cli,
          args: spawnArgs(config, assets),
          cwd: request.cwd,
          env: { ...request.env, [PI_READINESS_PROBE_ENV]: '0' },
          timeoutMs: request.timeoutMs,
          processGroup: 'own',
          onShutdownRequested: () => parentControl.markAutomaticShutdown(),
          procControl: parentControl.procControl,
          ...(request.onStderrLine === undefined ? {} : { onStderrLine: request.onStderrLine }),
          ...(request.onStreams === undefined ? {} : { onStreams: request.onStreams }),
        },
        prompt: request.prompt,
        promptId: `opensquid-prompt-${request.attemptId}`,
        statsId: `opensquid-stats-${request.attemptId}`,
        ...(assets.statsTimeoutMs === undefined ? {} : { statsTimeoutMs: assets.statsTimeoutMs }),
        onEvent: (event) => {
          if (event.type !== 'tool_execution_end') return;
          const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : undefined;
          if (toolCallId === undefined || childSeen.has(toolCallId)) return;
          const details = asRecord(event.result)?.details;
          const usage = decodeSubagentUsage(details);
          const control = decodeSubagentControlOutcome(details);
          if (control !== null) childControlOutcome ??= control;
          if (usage === null) return;
          childSeen.add(toolCallId);
          childUsage.inputTokens += usage.inputTokens;
          childUsage.outputTokens += usage.outputTokens;
          childUsage.cacheReadTokens += usage.cacheReadTokens;
          childUsage.cacheWriteTokens += usage.cacheWriteTokens;
          childUsage.costUsd += usage.costUsd;
        },
      });
    } catch (error) {
      const localCause = parentControl.shutdownCause();
      const cause =
        localCause?.kind === 'human'
          ? localCause
          : await durableParentHumanCause(parentExecutorId, parentControl.processInstanceId).catch(
              () => undefined,
            );
      if (cause !== undefined) throw new ProcessPausedError(parentExecutorId, cause);
      throw error;
    } finally {
      parentControl.dispose();
    }
    const localSettledCause = parentControl.shutdownCause();
    const settledCause =
      localSettledCause?.kind === 'human'
        ? localSettledCause
        : await durableParentHumanCause(parentExecutorId, parentControl.processInstanceId).catch(
            () => undefined,
          );
    if (settledCause !== undefined) {
      throw new ProcessPausedError(parentExecutorId, settledCause);
    }

    const parentCost = parent.hasNativeCost ? parent.usage.costUsd : 0;
    return {
      resultText: parent.text,
      costUsd: parentCost + childUsage.costUsd,
      inputTokens: parent.usage.inputTokens + childUsage.inputTokens,
      outputTokens: parent.usage.outputTokens + childUsage.outputTokens,
      cacheReadTokens: parent.usage.cacheReadTokens + childUsage.cacheReadTokens,
      cacheWriteTokens: parent.usage.cacheWriteTokens + childUsage.cacheWriteTokens,
      ...(childControlOutcome === null ? {} : { controlOutcome: childControlOutcome }),
      isError: parent.isError,
    };
  },
};
