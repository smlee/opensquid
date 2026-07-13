import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ModelAliasConfig } from '../../models/types.js';
import type {
  OpenSquidSubagentUsageV1,
  PiSubagentChildDetails,
  SpawnSubagentDetails,
} from './subagent_usage.js';
import { decodeChildRunUsage } from './subagent_usage.js';
import {
  PI_ROLE_MANIFEST_HASH_ENV,
  PI_ROLE_MANIFEST_PATH_ENV,
  PI_SHELL_COMMAND_PREFIX_ENV,
  PI_SHELL_PATH_ENV,
} from './env.js';
import { loadEffectivePiShellSettings } from './runtime.js';
import { runPiRpcAgentSession, type PiRpcUsage } from './rpc_agent_session.js';
import { runStreamingCli } from '../../runtime/streaming_cli.js';
import { realProcControl, type ProcControl } from '../../runtime/spawn_lifecycle.js';
import {
  DEFAULT_SUBAGENT_TIMEOUT_MS,
  type SubagentLauncher,
  type SubagentControlOutcome,
  type SubagentRunResult,
  type ValidatedSubagentTask,
} from '../../runtime/subagents/types.js';
import {
  DEFAULT_EXECUTOR_BACKOFF_MS,
  DEFAULT_EXECUTOR_MAX_LAPS,
  executorLapPrompt,
  runExecutorLoop,
  type ExecutorLoopLimits,
} from '../../runtime/subagents/executor_loop.js';
import {
  controlledExecutorProcess,
  listExecutorProcesses,
  type ProcessShutdownCause,
} from '../../runtime/subagents/process_control.js';
import { LOOP_LAP_ENV } from '../../runtime/hooks/subagent_guard.js';
import { extractTypedExit, type LapOutcome } from '../../runtime/ralph/lap_outcome.js';
import { SubagentAbortError, truncateUtf8 } from '../../runtime/subagents/supervisor.js';

const SESSION_ENV = 'OPENSQUID_SESSION_ID';
const ITEM_ENV = 'OPENSQUID_ITEM_ID';
const AUTOMATION_ENV = 'OPENSQUID_AUTOMATION';
const EXECUTOR_ENV = 'OPENSQUID_EXECUTOR';
const EXECUTOR_ID_ENV = 'OPENSQUID_EXECUTOR_ID';
const MAX_DETAIL_RESULT_TEXT_BYTES = 4 * 1024;

interface UsageAccumulator {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

function usageV1(usage: UsageAccumulator): OpenSquidSubagentUsageV1 {
  return {
    version: 1,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    costUsd: usage.costUsd,
  };
}

interface ParentEnvIdentity {
  readonly sessionId: string;
  readonly itemId: string;
}

export interface PiExecutorOutputLine {
  readonly childId: string;
  readonly role: string;
  readonly line: string;
}

export interface PiSubagentLauncherOptions {
  readonly cli: string;
  /** @deprecated Compatibility metadata only; native Pi inheritance omits flags unless a role alias is explicit. */
  readonly provider?: string;
  /** @deprecated Compatibility metadata only; native Pi inheritance omits flags unless a role alias is explicit. */
  readonly model?: string;
  readonly systemPromptPath: string;
  readonly adapterExtensionPath: string;
  readonly projectorExtensionPath: string;
  /** Total executor-loop wall clock; each fresh Pi lap receives only the remaining budget. */
  readonly timeoutMs?: number;
  readonly statsTimeoutMs?: number;
  /** Production spawn_subagent supplies this; omission/false keeps a single-session protocol-test seam. */
  readonly executorLoop?: false | Partial<Omit<ExecutorLoopLimits, 'wallClockMs'>>;
  readonly modelAliasesByRole?: ReadonlyMap<string, Readonly<Record<string, ModelAliasConfig>>>;
  readonly childIdFactory?: () => string;
  /** Live executor stderr, including displayReport output, relayed by the parent extension. */
  readonly onStderrLine?: (event: PiExecutorOutputLine) => void;
}

export interface PiSubagentLauncherDeps {
  readonly runStreaming: typeof runStreamingCli;
  readonly procControl: ProcControl;
  readonly makeTempDir: () => Promise<string>;
  readonly writeText: (path: string, text: string) => Promise<void>;
  readonly cleanupDir: (path: string) => Promise<void>;
  readonly readText: (path: string) => Promise<string>;
  readonly loadEffectiveShell?: typeof loadEffectivePiShellSettings;
  readonly listProcesses?: typeof listExecutorProcesses;
}

const DEFAULT_DEPS: PiSubagentLauncherDeps = {
  runStreaming: runStreamingCli,
  procControl: realProcControl,
  makeTempDir: () => mkdtemp(join(tmpdir(), 'opensquid-pi-subagent-')),
  writeText: (path, text) => writeFile(path, text, 'utf8'),
  cleanupDir: (path) => rm(path, { recursive: true, force: true }),
  readText: (path) => readFile(path, 'utf8'),
};

function validateParentEnv(env: NodeJS.ProcessEnv): ParentEnvIdentity {
  if ((env[LOOP_LAP_ENV] ?? '') !== '1') {
    throw new Error(`Pi subagent launcher requires ${LOOP_LAP_ENV}=1`);
  }
  if ((env[AUTOMATION_ENV] ?? '') !== '1') {
    throw new Error(`Pi subagent launcher requires ${AUTOMATION_ENV}=1`);
  }
  const sessionId = env[SESSION_ENV]?.trim();
  if (sessionId === undefined || sessionId === '') {
    throw new Error(`Pi subagent launcher requires non-empty ${SESSION_ENV}`);
  }
  const itemId = env[ITEM_ENV]?.trim();
  if (itemId === undefined || itemId === '') {
    throw new Error(`Pi subagent launcher requires non-empty ${ITEM_ENV}`);
  }
  if (
    typeof env[PI_ROLE_MANIFEST_PATH_ENV] !== 'string' ||
    env[PI_ROLE_MANIFEST_PATH_ENV]?.trim() === ''
  ) {
    throw new Error(`Pi subagent launcher requires non-empty ${PI_ROLE_MANIFEST_PATH_ENV}`);
  }
  if (
    typeof env[PI_ROLE_MANIFEST_HASH_ENV] !== 'string' ||
    !/^[a-f0-9]{64}$/.test(env[PI_ROLE_MANIFEST_HASH_ENV] ?? '')
  ) {
    throw new Error(`Pi subagent launcher requires sha256 ${PI_ROLE_MANIFEST_HASH_ENV}`);
  }
  return { sessionId, itemId };
}

function childEnv(
  parentEnv: NodeJS.ProcessEnv,
  childId: string,
  sessionId: string,
  shell: { commandPrefix?: string; shellPath?: string },
): NodeJS.ProcessEnv {
  validateParentEnv(parentEnv);
  const env: NodeJS.ProcessEnv = {
    ...parentEnv,
    [SESSION_ENV]: sessionId,
    [EXECUTOR_ENV]: '1',
    [EXECUTOR_ID_ENV]: childId,
  };
  if (shell.commandPrefix === undefined) delete env[PI_SHELL_COMMAND_PREFIX_ENV];
  else env[PI_SHELL_COMMAND_PREFIX_ENV] = shell.commandPrefix;
  if (shell.shellPath === undefined) delete env[PI_SHELL_PATH_ENV];
  else env[PI_SHELL_PATH_ENV] = shell.shellPath;
  return env;
}

function childDetails(usage: PiRpcUsage): PiSubagentChildDetails {
  return { usage: usageV1(usage) };
}

function emptyUsage(): PiRpcUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
  };
}

function addUsage(total: PiRpcUsage, next: PiRpcUsage): PiRpcUsage {
  return {
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    cacheReadTokens: total.cacheReadTokens + next.cacheReadTokens,
    cacheWriteTokens: total.cacheWriteTokens + next.cacheWriteTokens,
    costUsd: total.costUsd + next.costUsd,
  };
}

interface PiExecutorLapResult {
  readonly text: string;
  readonly isError: boolean;
  readonly usage: PiRpcUsage;
  readonly shutdownCause?: ProcessShutdownCause | undefined;
}

function executorDecision(
  lap: PiExecutorLapResult,
): { kind: 'complete' } | { kind: 'retry'; reason: string } | { kind: 'stop'; reason: string } {
  if (lap.shutdownCause?.kind === 'human') {
    return { kind: 'stop', reason: 'Pi executor process stopped by human control' };
  }
  if (lap.isError) return { kind: 'retry', reason: 'Pi executor lap crashed or timed out' };
  const outcome = extractTypedExit(lap.text);
  if (outcome?.kind === 'SHIPPED') return { kind: 'complete' };
  if (outcome?.kind === 'WEDGE' || outcome?.kind === 'HUMAN_REQUIRED') {
    return { kind: 'stop', reason: `Pi executor reported ${describeOutcome(outcome)}` };
  }
  return {
    kind: 'retry',
    reason:
      outcome === null
        ? 'Pi executor emitted no single valid typed exit'
        : `Pi executor reported retryable ${outcome.kind}`,
  };
}

function describeOutcome(outcome: LapOutcome): string {
  return outcome.kind === 'HUMAN_REQUIRED' ? `HUMAN_REQUIRED/${outcome.reason}` : outcome.kind;
}

function withoutTypedExit(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*RALPH-EXIT:\s*/u.test(line))
    .join('\n')
    .trimEnd();
}

export function piExecutorSpawnArgs(
  options: PiSubagentLauncherOptions,
  selection: { provider?: string; model?: string },
  role: ValidatedSubagentTask['role'],
  promptPath: string,
): string[] {
  return [
    '--mode',
    'rpc',
    '--no-session',
    '--no-approve',
    ...(selection.provider === undefined ? [] : ['--provider', selection.provider]),
    ...(selection.model === undefined ? [] : ['--model', selection.model]),
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
    '--system-prompt',
    promptPath,
    '--append-system-prompt',
    '',
    '-e',
    options.adapterExtensionPath,
    '-e',
    options.projectorExtensionPath,
    '--tools',
    role.tools.join(','),
  ];
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new SubagentAbortError();
}

function resolveChildSelection(
  options: PiSubagentLauncherOptions,
  role: ValidatedSubagentTask['role'],
): { provider?: string; model?: string } {
  const aliasName = role.model;
  // No role-specific override means native Pi inheritance: omit both flags. Every fresh child resolves the
  // user's active/default Pi settings; OpenSquid does not copy the parent's resolved provider/model.
  if (aliasName === undefined) return {};
  const alias =
    options.modelAliasesByRole?.get(role.generatedName)?.[aliasName] ??
    role.packModels?.[aliasName];
  if (alias === undefined) {
    throw new Error(`Unknown model alias for role ${role.name}: ${aliasName}`);
  }
  const provider = alias.provider?.trim();
  const model = alias.model?.trim();
  if (provider === undefined || provider === '' || model === undefined || model === '') {
    throw new Error(
      `Pi subagent role ${role.name} requires an explicit provider/model alias: ${aliasName}`,
    );
  }
  return { provider, model };
}

function controlOutcome(
  executorId: string,
  cause: ProcessShutdownCause | undefined,
): SubagentControlOutcome | undefined {
  if (cause?.kind !== 'human') return undefined;
  return {
    kind: cause.action === 'graceful_stop' ? 'PROCESS_PAUSED' : 'CANCELLED_BY_HUMAN',
    executorId,
    action: cause.action,
    actionId: cause.actionId,
  };
}

async function durableHumanCause(
  executorId: string,
  processInstanceId: string,
  list: typeof listExecutorProcesses,
): Promise<ProcessShutdownCause | undefined> {
  const state = (await list()).find(
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

async function inheritedRunHumanCause(
  env: NodeJS.ProcessEnv,
  list: typeof listExecutorProcesses,
): Promise<ProcessShutdownCause | undefined> {
  const runId = env.OPENSQUID_RUN_ID;
  if (runId === undefined) return undefined;
  const parent = (await list()).find(
    (candidate) =>
      candidate.actor === 'parent' &&
      candidate.runId === runId &&
      candidate.latestAction !== undefined &&
      (candidate.status === 'shutdown_requested' ||
        candidate.status === 'terminate_requested' ||
        candidate.status === 'force_kill_requested' ||
        candidate.status === 'paused'),
  );
  const action = parent?.latestAction;
  if (action === undefined || action.action === 'resume') return undefined;
  return {
    kind: 'human',
    action: action.action,
    requestedBy: action.requestedBy,
    authorizedBy: action.authorizedBy,
    actionId: action.actionId,
  };
}

export class PiSubagentLauncher implements SubagentLauncher<PiSubagentChildDetails> {
  constructor(
    private readonly options: PiSubagentLauncherOptions,
    private readonly parentEnv: NodeJS.ProcessEnv,
    private readonly deps: PiSubagentLauncherDeps = DEFAULT_DEPS,
  ) {}

  private async runLap(
    input: ValidatedSubagentTask,
    signal: AbortSignal,
    childId: string,
    promptPath: string,
    selection: { provider?: string; model?: string },
    shell: { commandPrefix?: string; shellPath?: string },
    lap: number,
    timeoutMs: number,
  ): Promise<PiExecutorLapResult> {
    const inheritedStop = await inheritedRunHumanCause(
      this.parentEnv,
      this.deps.listProcesses ?? listExecutorProcesses,
    ).catch(() => undefined);
    if (inheritedStop !== undefined) {
      return {
        text: 'executor run is paused by human control',
        isError: true,
        usage: emptyUsage(),
        shutdownCause: inheritedStop,
      };
    }
    const control = controlledExecutorProcess({
      executorId: childId,
      wgId: validateParentEnv(this.parentEnv).itemId,
      ...(this.parentEnv.OPENSQUID_RUN_ID === undefined
        ? {}
        : { runId: this.parentEnv.OPENSQUID_RUN_ID }),
      ...(this.parentEnv.OPENSQUID_CHECKPOINT_STAGE === undefined
        ? {}
        : { checkpointStage: this.parentEnv.OPENSQUID_CHECKPOINT_STAGE }),
      lap,
      role: input.role.name,
      base: this.deps.procControl,
      automaticSignal: signal,
    });
    try {
      const session = await runPiRpcAgentSession({
        runStreaming: this.deps.runStreaming,
        transport: {
          cli: this.options.cli,
          args: piExecutorSpawnArgs(this.options, selection, input.role, promptPath),
          cwd: input.cwd,
          env: childEnv(
            this.parentEnv,
            childId,
            `${childId}-lap-${String(lap)}-${control.processInstanceId}`,
            shell,
          ),
          timeoutMs,
          processGroup: 'own',
          onShutdownRequested: () => control.markAutomaticShutdown(),
          procControl: control.procControl,
          ...(this.options.onStderrLine === undefined
            ? {}
            : {
                onStderrLine: (line: string) =>
                  this.options.onStderrLine?.({ childId, role: input.role.name, line }),
              }),
        },
        prompt:
          this.options.executorLoop === undefined || this.options.executorLoop === false
            ? input.task
            : executorLapPrompt(input.task, lap),
        promptId: `${childId}-lap-${String(lap)}-prompt`,
        statsId: `${childId}-lap-${String(lap)}-stats`,
        ...(this.options.statsTimeoutMs === undefined
          ? {}
          : { statsTimeoutMs: this.options.statsTimeoutMs }),
        timers: {
          setTimeout: (callback, ms) => this.deps.procControl.setTimeout(callback, ms),
          clearTimeout: (timer) => this.deps.procControl.clearTimeout(timer),
        },
      });
      throwIfAborted(signal);
      const shutdownCause =
        control.shutdownCause() ??
        (await durableHumanCause(
          childId,
          control.processInstanceId,
          this.deps.listProcesses ?? listExecutorProcesses,
        ).catch(() => undefined));
      const humanStopped = shutdownCause?.kind === 'human';
      return {
        text:
          session.text !== ''
            ? session.text
            : (session.diagnostics[session.diagnostics.length - 1] ?? ''),
        isError: session.isError || humanStopped,
        usage: session.usage,
        ...(shutdownCause === null ? {} : { shutdownCause }),
      };
    } catch (error) {
      if (signal.aborted) throw new SubagentAbortError();
      const shutdownCause =
        control.shutdownCause() ??
        (await durableHumanCause(
          childId,
          control.processInstanceId,
          this.deps.listProcesses ?? listExecutorProcesses,
        ).catch(() => undefined));
      return {
        text:
          (error as { __timeout?: boolean }).__timeout === true
            ? 'subagent timed out'
            : error instanceof Error
              ? error.message
              : String(error),
        isError: true,
        usage: emptyUsage(),
        ...(shutdownCause === null ? {} : { shutdownCause }),
      };
    } finally {
      control.dispose();
    }
  }

  async run(
    input: ValidatedSubagentTask,
    signal: AbortSignal,
  ): Promise<SubagentRunResult<PiSubagentChildDetails>> {
    throwIfAborted(signal);
    let tempDir: string | undefined;
    const childId = `pi-child-${(this.options.childIdFactory ?? randomUUID)()}`;

    try {
      tempDir = await this.deps.makeTempDir();
      throwIfAborted(signal);
      const promptPath = join(tempDir, 'system-prompt.md');
      const baseline = await this.deps.readText(this.options.systemPromptPath);
      throwIfAborted(signal);
      await this.deps.writeText(
        promptPath,
        `${baseline.trim()}\n\n${input.role.systemPrompt.trim()}\n`,
      );
      throwIfAborted(signal);

      const selection = resolveChildSelection(this.options, input.role);
      const shell = await (this.deps.loadEffectiveShell ?? loadEffectivePiShellSettings)(
        input.cwd,
        this.parentEnv,
      );
      const wallClockMs = this.options.timeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS;

      if (this.options.executorLoop === undefined || this.options.executorLoop === false) {
        const lap = await this.runLap(
          input,
          signal,
          childId,
          promptPath,
          selection,
          shell,
          1,
          wallClockMs,
        );
        const stopped = controlOutcome(childId, lap.shutdownCause);
        return {
          role: input.role.name,
          text: lap.text,
          isError: lap.isError,
          ...(stopped === undefined ? {} : { controlOutcome: stopped }),
          details: childDetails(lap.usage),
        };
      }

      const loop = await runExecutorLoop({
        executorId: childId,
        limits: {
          maxLaps: this.options.executorLoop?.maxLaps ?? DEFAULT_EXECUTOR_MAX_LAPS,
          wallClockMs,
          backoffMs: this.options.executorLoop?.backoffMs ?? DEFAULT_EXECUTOR_BACKOFF_MS,
        },
        signal,
        runLap: (context, innerSignal) =>
          this.runLap(
            input,
            innerSignal,
            context.executorId,
            promptPath,
            selection,
            shell,
            context.lap,
            context.timeoutMs,
          ),
        decide: executorDecision,
      });
      throwIfAborted(signal);
      const totalUsage = loop.laps.reduce((total, lap) => addUsage(total, lap.usage), emptyUsage());
      const last = loop.laps[loop.laps.length - 1];
      const cleanText = last === undefined ? '' : withoutTypedExit(last.text);
      const text =
        cleanText !== ''
          ? cleanText
          : loop.terminal === 'complete'
            ? 'executor completed'
            : (loop.reason ?? 'executor loop stopped without a result');
      const stopped = controlOutcome(childId, last?.shutdownCause);
      return {
        role: input.role.name,
        text,
        isError: loop.terminal !== 'complete',
        ...(stopped === undefined ? {} : { controlOutcome: stopped }),
        details: childDetails(totalUsage),
      };
    } catch (error) {
      if (signal.aborted) throw new SubagentAbortError();
      return {
        role: input.role.name,
        text: error instanceof Error ? error.message : String(error),
        isError: true,
        details: childDetails(emptyUsage()),
      };
    } finally {
      if (tempDir !== undefined) await this.deps.cleanupDir(tempDir);
    }
  }
}

export function spawnSubagentDetails(input: {
  results: readonly {
    role: string;
    text: string;
    isError: boolean;
    controlOutcome?: SubagentControlOutcome;
  }[];
  usage: OpenSquidSubagentUsageV1;
}): SpawnSubagentDetails {
  const control = input.results.find(
    (result) => result.controlOutcome !== undefined,
  )?.controlOutcome;
  return {
    results: input.results.map((result) => ({
      role: result.role,
      text: truncateUtf8(result.text, MAX_DETAIL_RESULT_TEXT_BYTES),
      isError: result.isError,
      ...(result.controlOutcome === undefined ? {} : { controlOutcome: result.controlOutcome }),
    })),
    opensquidSubagentUsage: input.usage,
    ...(control === undefined ? {} : { controlOutcome: control }),
  };
}

export function usageFromResults(
  results: readonly SubagentRunResult<unknown>[],
): OpenSquidSubagentUsageV1 {
  return results.reduce<OpenSquidSubagentUsageV1>(
    (usage, result) => {
      const detail = decodeChildRunUsage(result.details);
      if (detail === null) return usage;
      return {
        version: 1,
        inputTokens: usage.inputTokens + detail.inputTokens,
        outputTokens: usage.outputTokens + detail.outputTokens,
        cacheReadTokens: usage.cacheReadTokens + detail.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens + detail.cacheWriteTokens,
        costUsd: usage.costUsd + detail.costUsd,
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
  );
}
