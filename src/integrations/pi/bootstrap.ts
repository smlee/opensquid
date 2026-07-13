import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStreamingCli } from '../../runtime/streaming_cli.js';
import { ensurePiAdapter } from './installer.js';
import {
  assertExactEffectivePiConfig,
  defaultPiExpectedConfig,
  loadEffectivePiConfig,
  type PiEffectiveConfig,
  type PiExpectedMcpConfig,
} from './mcp_config.js';
import { resolvePiMetadataCachePath } from './paths.js';

export interface VerifiedPiMcpRuntime {
  readonly adapterEntry: string;
  readonly adapterVersion: string;
  readonly configHash: string;
  readonly cacheHash: string;
  readonly mcpTools: ReadonlySet<string>;
}

export interface PiMcpReadyInput {
  readonly cli: string;
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly opensquidRoot?: string;
  readonly enabledOptional?: ReadonlySet<string>;
  readonly timeoutMs?: number;
  readonly runStreaming?: typeof runStreamingCli;
}

export interface PiMcpReadyDeps {
  loadEffectiveConfig(input: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<PiEffectiveConfig>;
  ensureAdapterAvailable(input: {
    cli: string;
    cwd: string;
    env?: NodeJS.ProcessEnv;
  }): Promise<{ adapterEntry: string; version: string }>;
  bootstrapCache(input: {
    cli: string;
    cwd: string;
    env?: NodeJS.ProcessEnv;
    adapterEntry: string;
    expectedHash: string;
    expectedTools: ReadonlySet<string>;
    timeoutMs: number;
    runStreaming?: typeof runStreamingCli;
  }): Promise<string>;
  probeMcpTools(input: {
    cli: string;
    cwd: string;
    env?: NodeJS.ProcessEnv;
    adapterEntry: string;
    expected: ReadonlySet<string>;
    timeoutMs: number;
    runStreaming?: typeof runStreamingCli;
  }): Promise<{ names: ReadonlySet<string>; cacheHash: string }>;
}

// Pi may cold-load TypeScript extensions and start two MCP servers before direct tools appear. Ten seconds was
// observably flaky on an otherwise healthy local setup, causing every supervised lap to fail in preflight.
const DEFAULT_TIMEOUT_MS = 60_000;
const CACHE_VERSION = 1;
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const PI_BUILTIN_TOOLS = new Set(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']);
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

interface ProbePayload {
  all: string[];
  active: string[];
}

const formatUnknownError = (value: unknown): string => {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

const isProbePayload = (value: unknown): value is ProbePayload =>
  isPlainObject(value) &&
  Array.isArray(value.all) &&
  Array.isArray(value.active) &&
  value.all.every((entry) => typeof entry === 'string') &&
  value.active.every((entry) => typeof entry === 'string');

export async function ensurePiMcpReady(
  input: PiMcpReadyInput,
  deps: PiMcpReadyDeps = {
    loadEffectiveConfig: loadEffectivePiConfig,
    ensureAdapterAvailable: ensurePiAdapter,
    bootstrapCache: bootstrapPiMcpCache,
    probeMcpTools: probePiMcpTools,
  },
): Promise<VerifiedPiMcpRuntime> {
  const expected = defaultPiExpectedConfig({
    cwd: input.cwd,
    ...(input.env === undefined ? {} : { env: input.env }),
    ...(input.opensquidRoot === undefined ? {} : { opensquidRoot: input.opensquidRoot }),
    ...(input.enabledOptional === undefined ? {} : { enabledOptional: input.enabledOptional }),
  });
  const effective = await deps.loadEffectiveConfig({
    cwd: input.cwd,
    ...(input.env === undefined ? {} : { env: input.env }),
  });
  assertExactEffectivePiConfig(effective, expected);
  const adapter = await deps.ensureAdapterAvailable({
    cli: input.cli,
    cwd: input.cwd,
    ...(input.env === undefined ? {} : { env: input.env }),
  });
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cacheHash = await deps.bootstrapCache({
    cli: input.cli,
    cwd: input.cwd,
    ...(input.env === undefined ? {} : { env: input.env }),
    adapterEntry: adapter.adapterEntry,
    expectedHash: expected.hash,
    expectedTools: expected.mcpTools,
    timeoutMs,
    ...(input.runStreaming === undefined ? {} : { runStreaming: input.runStreaming }),
  });
  const tools = await deps.probeMcpTools({
    cli: input.cli,
    cwd: input.cwd,
    ...(input.env === undefined ? {} : { env: input.env }),
    adapterEntry: adapter.adapterEntry,
    expected: expected.mcpTools,
    timeoutMs,
    ...(input.runStreaming === undefined ? {} : { runStreaming: input.runStreaming }),
  });
  return Object.freeze({
    adapterEntry: adapter.adapterEntry,
    adapterVersion: adapter.version,
    configHash: expected.hash,
    cacheHash: tools.cacheHash ?? cacheHash,
    mcpTools: tools.names,
  });
}

export async function bootstrapPiMcpCache(input: {
  cli: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  adapterEntry: string;
  expectedHash: string;
  expectedTools: ReadonlySet<string>;
  timeoutMs: number;
  runStreaming?: typeof runStreamingCli;
  readText?: (path: string) => Promise<string>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<string> {
  const env = { ...process.env, ...(input.env ?? {}) };
  const readText = input.readText ?? ((path: string) => readFile(path, 'utf8'));
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const runStreaming = input.runStreaming ?? runStreamingCli;
  const stateId = 'opensquid-pi-bootstrap-state';
  let cacheHash: string | null = null;
  let sawState = false;

  await runStreaming({
    cli: input.cli,
    args: basePiProbeArgs(input.adapterEntry),
    cwd: input.cwd,
    env,
    timeoutMs: input.timeoutMs,
    onStart: (ctx) => ctx.send(JSON.stringify({ id: stateId, type: 'get_state' })),
    onRecord: async (record, ctx) => {
      const event = JSON.parse(record) as Record<string, unknown>;
      if (event.type === 'extension_error') {
        return {
          fail: new Error(`Pi bootstrap extension error: ${formatUnknownError(event.error)}`),
        };
      }
      if (
        event.type === 'response' &&
        event.id === stateId &&
        event.command === 'get_state' &&
        event.success !== true
      ) {
        return {
          fail: new Error(`Pi bootstrap get_state failed: ${formatUnknownError(event.error)}`),
        };
      }
      if (
        event.type === 'response' &&
        event.id === stateId &&
        event.command === 'get_state' &&
        event.success === true
      ) {
        sawState = true;
        cacheHash = await pollForCacheHash({
          expectedHash: input.expectedHash,
          expectedTools: input.expectedTools,
          path: resolvePiMetadataCachePath(env),
          readText,
          now,
          sleep,
          timeoutMs: input.timeoutMs,
        });
        ctx.complete();
      }
      return 'continue';
    },
  });

  if (!sawState || cacheHash === null) {
    throw new Error('Pi MCP bootstrap did not observe get_state or cache readiness');
  }
  return cacheHash;
}

export async function probePiMcpTools(input: {
  cli: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  adapterEntry: string;
  expected: ReadonlySet<string>;
  timeoutMs: number;
  runStreaming?: typeof runStreamingCli;
  readText?: (path: string) => Promise<string>;
  makeTempDir?: () => Promise<string>;
  writeText?: (path: string, text: string) => Promise<void>;
  cleanupDir?: (path: string) => Promise<void>;
  now?: () => number;
}): Promise<{ names: ReadonlySet<string>; cacheHash: string }> {
  const env = { ...process.env, ...(input.env ?? {}) };
  const runStreaming = input.runStreaming ?? runStreamingCli;
  const readText = input.readText ?? ((path: string) => readFile(path, 'utf8'));
  const makeTempDir = input.makeTempDir ?? (() => mkdtemp(join(tmpdir(), 'opensquid-pi-probe-')));
  const writeText = input.writeText ?? writeFile;
  const cleanupDir =
    input.cleanupDir ?? ((path: string) => rm(path, { recursive: true, force: true }));
  const now = input.now ?? Date.now;
  const tempDir = await makeTempDir();
  const probePath = join(tempDir, 'probe.ts');
  const expectedNames = [...input.expected].sort();
  let payload: ProbePayload | null = null;

  try {
    await writeText(probePath, buildProbeExtensionSource(expectedNames));
    await runStreaming({
      cli: input.cli,
      args: [...basePiProbeArgs(input.adapterEntry), '-e', probePath],
      cwd: input.cwd,
      env,
      timeoutMs: input.timeoutMs,
      onRecord: (record) => {
        const event = JSON.parse(record) as Record<string, unknown>;
        if (event.type !== 'extension_ui_request' || event.method !== 'notify') return 'continue';
        if (typeof event.message !== 'string' || !event.message.startsWith('OPENSQUID_PI_PROBE ')) {
          return 'continue';
        }
        const parsed: unknown = JSON.parse(event.message.slice('OPENSQUID_PI_PROBE '.length));
        if (!isProbePayload(parsed)) return 'continue';
        payload = parsed;
        return 'complete';
      },
    });
  } finally {
    await cleanupDir(tempDir);
  }

  if (payload === null) throw new Error('Pi MCP probe emitted no payload');
  const probePayload: ProbePayload = payload;
  if (probePayload.all.includes('mcp')) {
    throw new Error('Pi MCP probe found forbidden generic mcp tool');
  }
  const unexpected = probePayload.all.filter(
    (name) => !PI_BUILTIN_TOOLS.has(name) && !input.expected.has(name),
  );
  if (unexpected.length > 0) {
    throw new Error(`Pi MCP probe found unexpected direct tools: ${unexpected.join(', ')}`);
  }
  const active = new Set<string>(probePayload.active);
  const missing = [...input.expected].filter((name) => !probePayload.all.includes(name));
  if (missing.length > 0) {
    throw new Error(`Pi MCP probe missing direct tools: ${missing.join(', ')}`);
  }
  if (
    active.size !== input.expected.size ||
    [...input.expected].some((name) => !active.has(name))
  ) {
    throw new Error(
      `Pi MCP probe active tools mismatch: expected ${[...input.expected].join(', ')}, got ${probePayload.active.join(', ')}`,
    );
  }
  const cacheHash = await readValidatedCacheHash({
    path: resolvePiMetadataCachePath(env),
    readText,
    expectedTools: input.expected,
    now,
  });
  if (cacheHash === null)
    throw new Error('Pi MCP probe could not read a valid opensquid cache hash');
  return { names: active, cacheHash };
}

function basePiProbeArgs(adapterEntry: string): string[] {
  return [
    '--mode',
    'rpc',
    '--no-approve',
    '--no-session',
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
    '-e',
    adapterEntry,
  ];
}

async function pollForCacheHash(input: {
  expectedHash: string;
  expectedTools: ReadonlySet<string>;
  path: string;
  readText: (path: string) => Promise<string>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
}): Promise<string> {
  const deadline = input.now() + input.timeoutMs;
  while (input.now() <= deadline) {
    const hash = await readValidatedCacheHash({
      path: input.path,
      readText: input.readText,
      expectedHash: input.expectedHash,
      expectedTools: input.expectedTools,
      now: input.now,
    });
    if (hash === input.expectedHash) return hash;
    await input.sleep(25);
  }
  throw new Error(`Pi MCP cache bootstrap timed out waiting for hash ${input.expectedHash}`);
}

async function readValidatedCacheHash(input: {
  path: string;
  readText: (path: string) => Promise<string>;
  expectedHash?: string;
  expectedTools: ReadonlySet<string>;
  now: () => number;
}): Promise<string | null> {
  try {
    const parsed = JSON.parse(await input.readText(input.path)) as unknown;
    if (
      !isPlainObject(parsed) ||
      parsed.version !== CACHE_VERSION ||
      !isPlainObject(parsed.servers)
    ) {
      return null;
    }
    const entry = parsed.servers.opensquid;
    if (!isPlainObject(entry)) return null;
    if (typeof entry.configHash !== 'string' || entry.configHash === '') return null;
    if (input.expectedHash !== undefined && entry.configHash !== input.expectedHash) return null;
    if (typeof entry.cachedAt !== 'number' || !Number.isFinite(entry.cachedAt)) return null;
    if (input.now() - entry.cachedAt > CACHE_MAX_AGE_MS) return null;
    if (!Array.isArray(entry.tools) || !Array.isArray(entry.resources)) return null;
    const toolNames = new Set<string>();
    for (const tool of entry.tools) {
      if (!isPlainObject(tool) || typeof tool.name !== 'string' || tool.name.trim() === '')
        return null;
      toolNames.add(tool.name);
    }
    for (const resource of entry.resources) {
      if (
        !isPlainObject(resource) ||
        typeof resource.name !== 'string' ||
        resource.name.trim() === '' ||
        typeof resource.uri !== 'string' ||
        resource.uri.trim() === ''
      ) {
        return null;
      }
    }
    if ([...input.expectedTools].some((name) => !toolNames.has(name))) return null;
    return entry.configHash;
  } catch {
    return null;
  }
}

function buildProbeExtensionSource(expected: readonly string[]): string {
  const toolJson = JSON.stringify(expected);
  return [
    "import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';",
    'export default function (pi: ExtensionAPI) {',
    "  pi.on('session_start', async (_event, ctx) => {",
    `    pi.setActiveTools(${toolJson});`,
    '    ctx.ui.notify(',
    "      'OPENSQUID_PI_PROBE ' + JSON.stringify({",
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

export function expectedPiMcpConfig(input: PiMcpReadyInput): PiExpectedMcpConfig {
  return defaultPiExpectedConfig({
    cwd: input.cwd,
    ...(input.env === undefined ? {} : { env: input.env }),
    ...(input.opensquidRoot === undefined ? {} : { opensquidRoot: input.opensquidRoot }),
    ...(input.enabledOptional === undefined ? {} : { enabledOptional: input.enabledOptional }),
  });
}
