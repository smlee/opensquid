import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { realProcControl, runOneShotCli } from '../../runtime/spawn_lifecycle.js';
import { runStreamingCli } from '../../runtime/streaming_cli.js';
import type { PiHarnessRuntimeAssets, VerifiedPiRuntime } from '../../runtime/ralph/lap_harness.js';
import { PI_READINESS_PROBE_ENV } from './env.js';
import {
  enabledPiOptionalTools,
  stagePiTools,
  type PiToolCapability,
  PI_TOOL_CATALOG,
} from './capability_catalog.js';
import { ensurePiMcpReady } from './bootstrap.js';
import { resolvePiAdapterEntry, resolvePiGlobalSettingsPath } from './paths.js';
import {
  controlledOwnedProcess,
  ProcessPausedError,
} from '../../runtime/processes/process_control.js';

interface StageRuntimeProbePayload {
  all: string[];
  active: string[];
}

const PACKAGE_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const CONTEXT_ROOT = fileURLToPath(new URL('../../../context/', import.meta.url));
const DIST_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SYSTEM_PROMPT_PATH = join(CONTEXT_ROOT, 'pi-system-prompt.md');
const PROJECTOR_PATH = join(DIST_ROOT, 'dist', 'integrations', 'pi', 'projector.js');

export interface PiRuntimeDeps {
  ensurePiMcpReady: typeof ensurePiMcpReady;
  probePiStageRuntime: typeof probePiStageRuntime;
  getAvailablePiProviders: typeof getAvailablePiProviders;
  getResolvedPiModel: typeof getResolvedPiModel;
  readPiVersion: typeof readPiVersion;
  loadEffectivePiShellSettings: typeof loadEffectivePiShellSettings;
}

const DEFAULT_RUNTIME_DEPS: PiRuntimeDeps = {
  ensurePiMcpReady,
  probePiStageRuntime,
  getAvailablePiProviders,
  getResolvedPiModel,
  readPiVersion,
  loadEffectivePiShellSettings,
};

function stableStageTools(): string[] {
  return stagePiTools(enabledPiOptionalTools());
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function parseProbePayload(text: string): StageRuntimeProbePayload | null {
  const parsed = JSON.parse(text) as unknown;
  const record = asRecord(parsed);
  if (
    record === null ||
    !Array.isArray(record.all) ||
    !record.all.every((entry) => typeof entry === 'string') ||
    !Array.isArray(record.active) ||
    !record.active.every((entry) => typeof entry === 'string')
  ) {
    return null;
  }
  return {
    all: record.all,
    active: record.active,
  };
}

function describeUnknown(value: unknown): string {
  return value instanceof Error ? value.message : JSON.stringify(value ?? 'unknown');
}

function buildStageProbeExtensionSource(): string {
  return [
    "import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';",
    'export default function (pi: ExtensionAPI) {',
    "  pi.on('session_start', async (_event, ctx) => {",
    '    ctx.ui.notify(',
    "      'OPENSQUID_PI_STAGE ' + JSON.stringify({",
    '        all: pi.getAllTools().map((tool) => tool.name),',
    '        active: pi.getActiveTools(),',
    '      }),',
    "      'info',",
    '    );',
    '    ctx.shutdown();',
    '  });',
    '}',
    '',
  ].join('\n');
}

function baseStageArgs(input: { adapterEntry: string; stageTools: readonly string[] }): string[] {
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
    SYSTEM_PROMPT_PATH,
    '--append-system-prompt',
    '',
    '-e',
    input.adapterEntry,
    '-e',
    PROJECTOR_PATH,
    '--tools',
    input.stageTools.join(','),
  ];
}

function stageProbeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    OPENSQUID_AUTOMATION: '1',
    OPENSQUID_LOOP_LAP: '1',
    OPENSQUID_SESSION_ID: 'opensquid-pi-stage-probe-session',
    OPENSQUID_ITEM_ID: 'opensquid-pi-stage-probe-item',
    [PI_READINESS_PROBE_ENV]: '1',
  };
}

export async function probePiStageRuntime(input: {
  cli: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  adapterEntry: string;
  timeoutMs: number;
  stageTools?: readonly string[];
  runStreaming?: typeof runStreamingCli;
}): Promise<{ registeredTools: ReadonlySet<string>; activeTools: ReadonlySet<string> }> {
  const runStreaming = input.runStreaming ?? runStreamingCli;
  const env = stageProbeEnv({ ...process.env, ...(input.env ?? {}) });
  const stageTools = [...(input.stageTools ?? stableStageTools())];
  const tempDir = await mkdtemp(join(tmpdir(), 'opensquid-pi-stage-'));
  const probePath = join(tempDir, 'probe.ts');
  let payload: StageRuntimeProbePayload | null = null;
  try {
    await writeFile(probePath, buildStageProbeExtensionSource(), 'utf8');
    await runStreaming({
      cli: input.cli,
      args: [
        ...baseStageArgs({
          adapterEntry: input.adapterEntry,
          stageTools,
        }),
        '-e',
        probePath,
      ],
      cwd: input.cwd,
      env,
      timeoutMs: input.timeoutMs,
      onRecord: (record) => {
        const event = JSON.parse(record) as Record<string, unknown>;
        if (event.type === 'extension_error') {
          return {
            fail: new Error(`Pi stage probe extension error: ${describeUnknown(event.error)}`),
          };
        }
        if (event.type !== 'extension_ui_request' || event.method !== 'notify') return 'continue';
        if (typeof event.message !== 'string' || !event.message.startsWith('OPENSQUID_PI_STAGE ')) {
          return 'continue';
        }
        payload = parseProbePayload(event.message.slice('OPENSQUID_PI_STAGE '.length));
        return payload === null ? 'continue' : 'complete';
      },
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
  if (payload === null) throw new Error('Pi stage runtime probe emitted no payload');
  const probe = payload as StageRuntimeProbePayload;
  if (probe.all.includes('mcp') || probe.active.includes('mcp')) {
    throw new Error('Pi stage runtime probe found forbidden generic mcp tool');
  }
  const all = new Set<string>(probe.all);
  const active = new Set<string>(probe.active);
  const expected = new Set<string>(stageTools);
  const missingRegistered = [...expected].filter((tool) => !all.has(tool));
  if (missingRegistered.length > 0) {
    throw new Error(
      `Pi stage runtime is missing registered tools: ${missingRegistered.join(', ')}`,
    );
  }
  if (active.size !== expected.size || [...expected].some((tool) => !active.has(tool))) {
    throw new Error(
      `Pi stage runtime active tools mismatch: expected ${stageTools.join(', ')}, got ${probe.active.join(', ')}`,
    );
  }
  return { registeredTools: all, activeTools: active };
}

export async function getAvailablePiProviders(input: {
  cli: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  runStreaming?: typeof runStreamingCli;
}): Promise<ReadonlyMap<string, ReadonlySet<string> | null>> {
  const runStreaming = input.runStreaming ?? runStreamingCli;
  const env = { ...process.env, ...(input.env ?? {}) };
  const id = 'opensquid-get-models';
  let providers = new Map<string, ReadonlySet<string> | null>();
  await runStreaming({
    cli: input.cli,
    args: [
      '--mode',
      'rpc',
      '--no-approve',
      '--no-session',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
    ],
    cwd: input.cwd,
    env,
    timeoutMs: input.timeoutMs,
    onStart: (ctx) => ctx.send(JSON.stringify({ id, type: 'get_available_models' })),
    onRecord: (record, ctx) => {
      const event = JSON.parse(record) as Record<string, unknown>;
      if (
        event.type !== 'response' ||
        event.id !== id ||
        event.command !== 'get_available_models'
      ) {
        return 'continue';
      }
      if (event.success !== true) {
        return {
          fail: new Error(`Pi get_available_models failed: ${describeUnknown(event.error)}`),
        };
      }
      const data = asRecord(event.data);
      const models = Array.isArray(data?.models) ? data.models : [];
      const bucket = new Map<string, Set<string>>();
      for (const raw of models) {
        const model = asRecord(raw);
        const provider = typeof model?.provider === 'string' ? model.provider : undefined;
        const idValue = typeof model?.id === 'string' ? model.id : undefined;
        if (provider === undefined || idValue === undefined) continue;
        if (!bucket.has(provider)) bucket.set(provider, new Set());
        bucket.get(provider)?.add(idValue);
      }
      providers = new Map(
        [...bucket.entries()].map(([provider, ids]) => [provider, ids as ReadonlySet<string>]),
      );
      ctx.complete();
      return 'continue';
    },
  });
  return providers;
}

export async function getResolvedPiModel(input: {
  cli: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  runStreaming?: typeof runStreamingCli;
}): Promise<Readonly<{ provider: string; id: string }>> {
  const runStreaming = input.runStreaming ?? runStreamingCli;
  const id = 'opensquid-get-state';
  let resolved: { provider: string; id: string } | null = null;
  await runStreaming({
    cli: input.cli,
    args: [
      '--mode',
      'rpc',
      '--no-approve',
      '--no-session',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
    ],
    cwd: input.cwd,
    env: { ...process.env, ...(input.env ?? {}) },
    timeoutMs: input.timeoutMs,
    onStart: (ctx) => ctx.send(JSON.stringify({ id, type: 'get_state' })),
    onRecord: (record, ctx) => {
      const event = JSON.parse(record) as Record<string, unknown>;
      if (event.type !== 'response' || event.id !== id || event.command !== 'get_state') {
        return 'continue';
      }
      if (event.success !== true) {
        return { fail: new Error(`Pi get_state failed: ${describeUnknown(event.error)}`) };
      }
      const model = asRecord(asRecord(event.data)?.model);
      if (typeof model?.provider !== 'string' || typeof model.id !== 'string') {
        return {
          fail: new Error(
            'Pi has no resolved provider/model; select one through Pi or OpenSquid setup before running the loop',
          ),
        };
      }
      resolved = { provider: model.provider, id: model.id };
      ctx.complete();
      return 'continue';
    },
  });
  if (resolved === null) throw new Error('Pi get_state returned no resolved provider/model');
  return resolved;
}

export async function readPiVersion(input: {
  cli: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  runOneShot?: typeof runOneShotCli;
}): Promise<string> {
  const runOneShot = input.runOneShot ?? runOneShotCli;
  const stdout = await runOneShot({
    cli: input.cli,
    args: ['--version'],
    cwd: input.cwd,
    ...(input.env === undefined ? {} : { env: input.env }),
    prompt: '',
    timeoutMs: input.timeoutMs ?? 5_000,
    errorPrefix: 'Pi --version ',
    timeoutError: () => new Error('Pi --version timed out'),
  });
  const version = stdout.trim().replace(/^v/, '');
  if (version === '') {
    throw new Error('Pi --version returned empty output');
  }
  return version;
}

function isEnoent(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string' &&
    (error as { code?: string }).code === 'ENOENT'
  );
}

async function readOptionalSettings(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed = asRecord(JSON.parse(await readFile(path, 'utf8')) as unknown);
    if (parsed === null) throw new Error(`Pi settings must be a JSON object: ${path}`);
    return parsed;
  } catch (error) {
    if (isEnoent(error)) return {};
    throw error;
  }
}

/** Read the effective shell fields for OpenSquid's `--no-approve` invocation.
 * Pi does not load project settings for an explicitly untrusted project, so only agent-global settings apply. */
export async function loadEffectivePiShellSettings(
  _cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Readonly<{ commandPrefix?: string; shellPath?: string }>> {
  const global = await readOptionalSettings(resolvePiGlobalSettingsPath(env));
  const commandPrefix = global.shellCommandPrefix;
  const shellPath = global.shellPath;
  if (commandPrefix !== undefined && typeof commandPrefix !== 'string') {
    throw new Error('Pi shellCommandPrefix must be a string');
  }
  if (shellPath !== undefined && typeof shellPath !== 'string') {
    throw new Error('Pi shellPath must be a string');
  }
  return Object.freeze({
    ...(commandPrefix === undefined ? {} : { commandPrefix }),
    ...(shellPath === undefined ? {} : { shellPath }),
  });
}

export function createDefaultPiHarnessRuntimeAssets(
  options: {
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    opensquidRoot?: string;
  } = {},
  deps: PiRuntimeDeps = DEFAULT_RUNTIME_DEPS,
): PiHarnessRuntimeAssets {
  const env = options.env ?? process.env;
  const stageTools = stableStageTools();
  const adapterEntry = resolvePiAdapterEntry('pi-mcp-adapter', env);
  const readinessByTarget = new Map<string, Promise<VerifiedPiRuntime>>();
  return {
    systemPromptPath: SYSTEM_PROMPT_PATH,
    mcpAdapterExtensionPath: adapterEntry,
    projectorExtensionPath: PROJECTOR_PATH,
    stageTools,
    readiness: (input) => {
      const key = `${input.cli}\u0000${input.cwd}`;
      const cached = readinessByTarget.get(key);
      if (cached !== undefined) return cached;

      const readiness = (async (): Promise<VerifiedPiRuntime> => {
        let probe = 0;
        const readinessEnv = { ...env, ...(input.env ?? {}) };
        const trackedStreaming: typeof runStreamingCli = async (streamInput) => {
          const processId = `pi-readiness-${input.attemptId ?? randomUUID()}-${String(++probe)}`;
          const control = controlledOwnedProcess({
            processId,
            wgId: readinessEnv.OPENSQUID_ITEM_ID ?? 'pi-readiness',
            ...(readinessEnv.OPENSQUID_RUN_ID === undefined
              ? {}
              : { runId: readinessEnv.OPENSQUID_RUN_ID }),
            ...(readinessEnv.OPENSQUID_CHECKPOINT_STAGE === undefined
              ? {}
              : { checkpointStage: readinessEnv.OPENSQUID_CHECKPOINT_STAGE }),
            role: 'readiness-probe',
            ownership: 'owned',
            base: realProcControl,
          });
          try {
            const result = await runStreamingCli({
              ...streamInput,
              processGroup: 'own',
              procControl: control.procControl,
              onShutdownRequested: async () => {
                control.markAutomaticShutdown();
                await streamInput.onShutdownRequested?.();
              },
              onStderrLine: (line) => {
                streamInput.onStderrLine?.(line);
                process.stderr.write(`[${processId}] ${line}\n`);
              },
            });
            const cause = control.shutdownCause();
            if (cause?.kind === 'human') throw new ProcessPausedError(processId, cause);
            return result;
          } catch (error) {
            const cause = control.shutdownCause();
            if (cause?.kind === 'human') throw new ProcessPausedError(processId, cause);
            throw error;
          } finally {
            control.dispose();
          }
        };

        const mcp = await deps.ensurePiMcpReady({
          cli: input.cli,
          cwd: input.cwd,
          env: readinessEnv,
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
          opensquidRoot: options.opensquidRoot ?? PACKAGE_ROOT,
          runStreaming: trackedStreaming,
        });
        const full = await deps.probePiStageRuntime({
          cli: input.cli,
          cwd: input.cwd,
          env: readinessEnv,
          adapterEntry: mcp.adapterEntry,
          timeoutMs: options.timeoutMs ?? 60_000,
          stageTools,
          runStreaming: trackedStreaming,
        });
        const [providers, resolvedModel] = await Promise.all([
          deps.getAvailablePiProviders({
            cli: input.cli,
            cwd: input.cwd,
            env: readinessEnv,
            timeoutMs: options.timeoutMs ?? 60_000,
            runStreaming: trackedStreaming,
          }),
          deps.getResolvedPiModel({
            cli: input.cli,
            cwd: input.cwd,
            env: readinessEnv,
            timeoutMs: options.timeoutMs ?? 60_000,
            runStreaming: trackedStreaming,
          }),
        ]);
        const piVersion = await deps
          .readPiVersion({
            cli: input.cli,
            cwd: input.cwd,
            env: readinessEnv,
          })
          .catch(() => 'unknown');
        const effectiveShell = await deps.loadEffectivePiShellSettings(input.cwd, readinessEnv);
        return {
          piVersion,
          mcpAdapterVersion: mcp.adapterVersion,
          providers,
          resolvedModel,
          registeredTools: full.registeredTools,
          activeTools: full.activeTools,
          genericProxyAbsent: !full.registeredTools.has('mcp') && !full.activeTools.has('mcp'),
          effectiveShell,
        } satisfies VerifiedPiRuntime;
      })();
      readinessByTarget.set(key, readiness);
      void readiness.catch(() => {
        if (readinessByTarget.get(key) === readiness) readinessByTarget.delete(key);
      });
      return readiness;
    },
  };
}

export function defaultHarnessRuntimeAssets(): { pi: PiHarnessRuntimeAssets } {
  return { pi: createDefaultPiHarnessRuntimeAssets() };
}

export const PI_STAGE_TOOL_CATALOG: readonly PiToolCapability[] = PI_TOOL_CATALOG;
export const OPENSQUID_PACKAGE_ROOT = PACKAGE_ROOT;
