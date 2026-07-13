import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteFile } from '../../runtime/atomic_write.js';
import { mcpDirectTools, type PiToolCapability } from './capability_catalog.js';
import {
  resolvePiGlobalMcpConfigPath,
  resolveProjectMcpConfigPath,
  resolveProjectPiMcpConfigPath,
  resolveSharedGlobalMcpConfigPath,
} from './paths.js';

export type PiConfigSourceId = 'shared-global' | 'pi-global' | 'shared-project' | 'pi-project';

export interface PiMcpServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  auth?: 'oauth' | 'bearer' | false;
  bearerToken?: string;
  bearerTokenEnv?: string;
  oauth?: false | Record<string, unknown>;
  lifecycle?: 'keep-alive' | 'lazy' | 'eager';
  idleTimeout?: number;
  requestTimeoutMs?: number;
  exposeResources?: boolean;
  directTools?: boolean | string[];
  excludeTools?: string[];
  debug?: boolean;
  [k: string]: unknown;
}

export interface PiMcpSettings {
  toolPrefix?: 'server' | 'none' | 'short';
  idleTimeout?: number;
  requestTimeoutMs?: number;
  directTools?: boolean;
  disableProxyTool?: boolean;
  autoAuth?: boolean;
  sampling?: boolean;
  samplingAutoApprove?: boolean;
  elicitation?: boolean;
  outputGuard?: boolean | Record<string, unknown>;
  authRequiredMessage?: string;
  [k: string]: unknown;
}

export interface PiMcpConfigFile {
  mcpServers?: Record<string, PiMcpServerEntry>;
  imports?: string[];
  settings?: PiMcpSettings;
  [k: string]: unknown;
}

export interface PiConfigSource {
  readonly id: PiConfigSourceId;
  readonly path: string;
  readonly scope: 'global' | 'project';
  readonly kind: 'shared' | 'pi';
  readonly raw: PiMcpConfigFile;
  readonly parseError?: string;
}

export interface PiSourceProvenance {
  readonly id: PiConfigSourceId;
  readonly path: string;
  readonly scope: 'global' | 'project';
  readonly kind: 'shared' | 'pi';
}

export interface PiEffectiveConfig {
  readonly sources: readonly PiConfigSource[];
  readonly merged: Readonly<{
    mcpServers: Record<string, PiMcpServerEntry>;
    imports: readonly string[];
    settings: PiMcpSettings;
  }>;
  readonly serverProvenance: ReadonlyMap<string, PiSourceProvenance>;
  readonly settingProvenance: ReadonlyMap<string, PiSourceProvenance>;
  readonly importProvenance: readonly { value: string; source: PiSourceProvenance }[];
}

export interface PiExpectedMcpConfig {
  readonly path: string;
  readonly hash: string;
  readonly mcpTools: ReadonlySet<string>;
  readonly raw: Readonly<{
    settings: Required<
      Pick<
        PiMcpSettings,
        'toolPrefix' | 'disableProxyTool' | 'autoAuth' | 'sampling' | 'elicitation'
      >
    >;
    mcpServers: Readonly<{
      opensquid: PiMcpServerEntry;
      'opensquid-chat': PiMcpServerEntry;
    }>;
  }>;
}

export interface PiMcpWriteResult {
  added: string[];
  replaced: string[];
  preserved: number;
  backupPath: string;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const resolveHome = (env: NodeJS.ProcessEnv): string => env.HOME?.trim() ?? homedir();

export function buildExpectedPiMcpConfig(input: {
  path: string;
  opensquidRoot?: string;
  enabledOptional?: ReadonlySet<string>;
}): PiExpectedMcpConfig {
  const direct = mcpDirectTools(input.enabledOptional);
  const entry = buildServerEntries(input.opensquidRoot, direct);
  return {
    path: input.path,
    hash: computePiServerHash(entry.opensquid),
    mcpTools: new Set(direct),
    raw: {
      settings: {
        toolPrefix: 'none',
        disableProxyTool: true,
        autoAuth: false,
        sampling: false,
        elicitation: false,
      },
      mcpServers: entry,
    },
  };
}

function buildServerEntries(
  opensquidRoot: string | undefined,
  directTools: readonly string[],
): { opensquid: PiMcpServerEntry; 'opensquid-chat': PiMcpServerEntry } {
  const command = opensquidRoot === undefined ? 'opensquid-mcp' : 'node';
  const chatCommand = opensquidRoot === undefined ? 'opensquid-chat-bridge-mcp' : 'node';
  const serverArgs =
    opensquidRoot === undefined ? [] : [join(opensquidRoot, 'dist', 'mcp', 'server.js')];
  const chatArgs =
    opensquidRoot === undefined
      ? []
      : [join(opensquidRoot, 'dist', 'mcp', 'chat-bridge-server.js')];
  return {
    opensquid: {
      command,
      args: serverArgs,
      env: {},
      lifecycle: 'lazy',
      directTools: [...directTools],
    },
    'opensquid-chat': {
      command: chatCommand,
      args: chatArgs,
      env: {},
      lifecycle: 'lazy',
    },
  };
}

export async function readPiMcpConfig(path: string): Promise<PiMcpConfigFile> {
  try {
    return parseConfigText(await readFile(path, 'utf8'));
  } catch (error: unknown) {
    if (isErrnoException(error) && error.code === 'ENOENT') return {};
    throw error;
  }
}

export function projectPiMcpConfig(
  input: PiMcpConfigFile,
  expected: PiExpectedMcpConfig,
): { output: PiMcpConfigFile; added: string[]; replaced: string[]; preserved: number } {
  const output = JSON.parse(JSON.stringify(input)) as PiMcpConfigFile;
  output.settings = { ...(output.settings ?? {}), ...expected.raw.settings };
  output.mcpServers = { ...(output.mcpServers ?? {}) };
  const added: string[] = [];
  const replaced: string[] = [];
  for (const [name, server] of Object.entries(expected.raw.mcpServers)) {
    (output.mcpServers[name] === undefined ? added : replaced).push(name);
    output.mcpServers[name] = JSON.parse(JSON.stringify(server)) as PiMcpServerEntry;
  }
  const preserved = Object.keys(output.mcpServers).filter(
    (name) => name !== 'opensquid' && name !== 'opensquid-chat',
  ).length;
  return { output, added, replaced, preserved };
}

export async function writePiMcpConfig(
  path: string,
  expected: PiExpectedMcpConfig,
): Promise<PiMcpWriteResult> {
  const input = await readPiMcpConfig(path);
  const { output, added, replaced, preserved } = projectPiMcpConfig(input, expected);
  const before = `${JSON.stringify(input, null, 2)}\n`;
  const after = `${JSON.stringify(output, null, 2)}\n`;
  const backupPath = `${path}.bak`;
  if (before !== after) {
    await atomicWriteFile(backupPath, before);
    await atomicWriteFile(path, after);
  }
  return { added, replaced, preserved, backupPath };
}

export async function loadEffectivePiConfig(input: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<PiEffectiveConfig> {
  const env = input.env ?? process.env;
  const specs: readonly Omit<PiConfigSource, 'raw'>[] = [
    {
      id: 'shared-global',
      path: resolveSharedGlobalMcpConfigPath(env),
      scope: 'global',
      kind: 'shared',
    },
    {
      id: 'pi-global',
      path: resolvePiGlobalMcpConfigPath(env),
      scope: 'global',
      kind: 'pi',
    },
    {
      id: 'shared-project',
      path: resolveProjectMcpConfigPath(input.cwd),
      scope: 'project',
      kind: 'shared',
    },
    {
      id: 'pi-project',
      path: resolveProjectPiMcpConfigPath(input.cwd),
      scope: 'project',
      kind: 'pi',
    },
  ];

  const sources: PiConfigSource[] = [];
  const mergedServers: Record<string, PiMcpServerEntry> = {};
  const mergedSettings: PiMcpSettings = {};
  const mergedImports: string[] = [];
  const serverProvenance = new Map<string, PiSourceProvenance>();
  const settingProvenance = new Map<string, PiSourceProvenance>();
  const importProvenance: { value: string; source: PiSourceProvenance }[] = [];

  for (const spec of specs) {
    const loaded = await loadSource(spec.path);
    const source: PiConfigSource = {
      ...spec,
      raw: loaded.raw,
      ...(loaded.parseError === undefined ? {} : { parseError: loaded.parseError }),
    };
    sources.push(source);
    if (loaded.parseError !== undefined) continue;
    const provenance = toProvenance(spec);
    for (const [name, definition] of Object.entries(loaded.raw.mcpServers ?? {})) {
      mergedServers[name] = { ...(mergedServers[name] ?? {}), ...definition };
      serverProvenance.set(name, provenance);
    }
    for (const [name, value] of Object.entries(loaded.raw.settings ?? {})) {
      mergedSettings[name] = value;
      settingProvenance.set(name, provenance);
    }
    for (const value of loaded.raw.imports ?? []) {
      mergedImports.push(value);
      importProvenance.push({ value, source: provenance });
    }
  }

  return {
    sources,
    merged: { mcpServers: mergedServers, imports: mergedImports, settings: mergedSettings },
    serverProvenance,
    settingProvenance,
    importProvenance,
  };
}

export function assertExactEffectivePiConfig(
  effective: PiEffectiveConfig,
  expected: PiExpectedMcpConfig,
): void {
  const issues: string[] = [];

  for (const source of effective.sources) {
    if (source.parseError !== undefined) {
      issues.push(`${source.path}: invalid Pi MCP config (${source.parseError})`);
      continue;
    }
    const foreignServers = Object.keys(source.raw.mcpServers ?? {}).filter(
      (name) => name !== 'opensquid' && name !== 'opensquid-chat',
    );
    if (foreignServers.length > 0) {
      issues.push(`${source.path}: foreign MCP servers present (${foreignServers.join(', ')})`);
    }
    if ((source.raw.imports?.length ?? 0) > 0) {
      issues.push(`${source.path}: imports are forbidden (${source.raw.imports?.join(', ')})`);
    }
  }

  const mergedServers = effective.merged.mcpServers;
  const expectedServerNames = ['opensquid', 'opensquid-chat'] as const;
  const actualServerNames = Object.keys(mergedServers).sort();
  if (stableStringify(actualServerNames) !== stableStringify([...expectedServerNames].sort())) {
    issues.push(
      `effective server set mismatch: expected ${expectedServerNames.join(', ')} but found ${actualServerNames.join(', ') || '(none)'}`,
    );
  }

  for (const name of expectedServerNames) {
    const actual = mergedServers[name];
    const expectedServer = expected.raw.mcpServers[name];
    if (stableStringify(actual ?? null) !== stableStringify(expectedServer)) {
      const provenance = effective.serverProvenance.get(name);
      issues.push(`${name}: definition mismatch${provenance ? ` (from ${provenance.path})` : ''}`);
    }
  }

  const requiredSettings = expected.raw.settings;
  const allowedSettings = new Set([
    'toolPrefix',
    'disableProxyTool',
    'autoAuth',
    'sampling',
    'elicitation',
    'idleTimeout',
    'requestTimeoutMs',
    'outputGuard',
    'authRequiredMessage',
    'samplingAutoApprove',
  ]);
  for (const key of Object.keys(effective.merged.settings)) {
    if (!allowedSettings.has(key)) issues.push(`settings.${key}: unsupported for autonomous Pi`);
  }
  if (effective.merged.settings.directTools !== undefined) {
    const provenance = effective.settingProvenance.get('directTools');
    issues.push(
      `settings.directTools must be absent${provenance ? ` (from ${provenance.path})` : ''}`,
    );
  }
  for (const [key, value] of Object.entries(requiredSettings)) {
    if (stableStringify(effective.merged.settings[key]) !== stableStringify(value)) {
      const provenance = effective.settingProvenance.get(key);
      issues.push(
        `settings.${key}: expected ${stableStringify(value)}, found ${stableStringify(
          effective.merged.settings[key],
        )}${provenance ? ` (from ${provenance.path})` : ''}`,
      );
    }
  }

  if (issues.length > 0) {
    throw new Error(`Unsafe effective Pi MCP configuration:\n- ${issues.join('\n- ')}`);
  }
}

export function computePiServerHash(
  definition: PiMcpServerEntry,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const identity: Record<string, unknown> = {
    command: definition.command,
    args: definition.args,
    env: interpolateEnvRecord(definition.env, env),
    cwd: resolveConfigPath(definition.cwd, env),
    url: definition.url,
    headers: interpolateEnvRecord(definition.headers, env),
    auth: definition.auth,
    bearerToken: resolveBearerToken(definition, env),
    bearerTokenEnv: definition.bearerTokenEnv,
    exposeResources: definition.exposeResources,
    excludeTools: definition.excludeTools,
  };
  return createHash('sha256').update(stableStringify(identity)).digest('hex');
}

async function loadSource(path: string): Promise<{ raw: PiMcpConfigFile; parseError?: string }> {
  try {
    return { raw: parseConfigText(await readFile(path, 'utf8')) };
  } catch (error: unknown) {
    if (isErrnoException(error) && error.code === 'ENOENT') return { raw: {} };
    return { raw: {}, parseError: formatUnknownError(error) };
  }
}

function parseConfigText(text: string): PiMcpConfigFile {
  const parsed: unknown = JSON.parse(text);
  if (!isPlainObject(parsed)) throw new Error('root must be a JSON object');
  validateConfigObject(parsed, '$');
  return parsed;
}

function validateConfigObject(
  value: Record<string, unknown>,
  path: string,
): asserts value is PiMcpConfigFile {
  if ('imports' in value) validateImports(value.imports, `${path}.imports`);
  if ('settings' in value) validateSettings(value.settings, `${path}.settings`);
  if ('mcpServers' in value) validateServers(value.mcpServers, `${path}.mcpServers`);
}

function validateImports(value: unknown, path: string): void {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${path} must be an array of strings`);
  }
}

function validateServers(value: unknown, path: string): void {
  if (!isPlainObject(value)) throw new Error(`${path} must be an object`);
  for (const [name, entry] of Object.entries(value)) {
    validateServerEntry(entry, `${path}.${name}`);
  }
}

function validateServerEntry(value: unknown, path: string): void {
  if (!isPlainObject(value)) throw new Error(`${path} must be an object`);
  validateString(value.command, `${path}.command`);
  validateStringArray(value.args, `${path}.args`);
  validateStringRecord(value.env, `${path}.env`);
  validateString(value.cwd, `${path}.cwd`);
  validateString(value.url, `${path}.url`);
  validateStringRecord(value.headers, `${path}.headers`);
  validateEnum(value.auth, `${path}.auth`, ['oauth', 'bearer', false]);
  validateString(value.bearerToken, `${path}.bearerToken`);
  validateString(value.bearerTokenEnv, `${path}.bearerTokenEnv`);
  if (value.oauth !== undefined && value.oauth !== false && !isPlainObject(value.oauth)) {
    throw new Error(`${path}.oauth must be false or an object`);
  }
  validateEnum(value.lifecycle, `${path}.lifecycle`, ['keep-alive', 'lazy', 'eager']);
  validateNumber(value.idleTimeout, `${path}.idleTimeout`);
  validateNumber(value.requestTimeoutMs, `${path}.requestTimeoutMs`);
  validateBoolean(value.exposeResources, `${path}.exposeResources`);
  validateBooleanOrStringArray(value.directTools, `${path}.directTools`);
  validateStringArray(value.excludeTools, `${path}.excludeTools`);
  validateBoolean(value.debug, `${path}.debug`);
}

function validateSettings(value: unknown, path: string): void {
  if (!isPlainObject(value)) throw new Error(`${path} must be an object`);
  validateEnum(value.toolPrefix, `${path}.toolPrefix`, ['server', 'none', 'short']);
  validateNumber(value.idleTimeout, `${path}.idleTimeout`);
  validateNumber(value.requestTimeoutMs, `${path}.requestTimeoutMs`);
  validateBoolean(value.directTools, `${path}.directTools`);
  validateBoolean(value.disableProxyTool, `${path}.disableProxyTool`);
  validateBoolean(value.autoAuth, `${path}.autoAuth`);
  validateBoolean(value.sampling, `${path}.sampling`);
  validateBoolean(value.samplingAutoApprove, `${path}.samplingAutoApprove`);
  validateBoolean(value.elicitation, `${path}.elicitation`);
  if (
    value.outputGuard !== undefined &&
    typeof value.outputGuard !== 'boolean' &&
    !isPlainObject(value.outputGuard)
  ) {
    throw new Error(`${path}.outputGuard must be a boolean or object`);
  }
  validateString(value.authRequiredMessage, `${path}.authRequiredMessage`);
}

function validateString(value: unknown, path: string): void {
  if (value !== undefined && typeof value !== 'string') {
    throw new Error(`${path} must be a string`);
  }
}

function validateNumber(value: unknown, path: string): void {
  if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
    throw new Error(`${path} must be a finite number`);
  }
}

function validateBoolean(value: unknown, path: string): void {
  if (value !== undefined && typeof value !== 'boolean') {
    throw new Error(`${path} must be a boolean`);
  }
}

function validateStringArray(value: unknown, path: string): void {
  if (
    value !== undefined &&
    (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string'))
  ) {
    throw new Error(`${path} must be an array of strings`);
  }
}

function validateBooleanOrStringArray(value: unknown, path: string): void {
  if (value === undefined || typeof value === 'boolean') return;
  validateStringArray(value, path);
}

function validateStringRecord(value: unknown, path: string): void {
  if (value === undefined) return;
  if (!isPlainObject(value) || Object.values(value).some((entry) => typeof entry !== 'string')) {
    throw new Error(`${path} must be an object of strings`);
  }
}

function validateEnum(value: unknown, path: string, allowed: readonly (string | boolean)[]): void {
  if (value === undefined) return;
  if (typeof value !== 'string' && typeof value !== 'boolean') {
    throw new Error(`${path} must be one of ${allowed.map(String).join(', ')}`);
  }
  if (!allowed.includes(value)) {
    throw new Error(`${path} must be one of ${allowed.map(String).join(', ')}`);
  }
}

function interpolateEnvVars(value: string, env: NodeJS.ProcessEnv): string {
  return value
    .replace(/\$\{(\w+)\}/g, (_match: string, name: string) => env[name] ?? '')
    .replace(/\$env:(\w+)/g, (_match: string, name: string) => env[name] ?? '');
}

function interpolateEnvRecord(
  values: Record<string, string> | undefined,
  env: NodeJS.ProcessEnv,
): Record<string, string> | undefined {
  if (values === undefined) return undefined;
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    resolved[key] = interpolateEnvVars(value, env);
  }
  return resolved;
}

function resolveConfigPath(value: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  if (value === undefined) return undefined;
  const resolved = interpolateEnvVars(value, env);
  if (resolved === '~') return resolveHome(env);
  if (resolved.startsWith('~/') || resolved.startsWith('~\\')) {
    return join(resolveHome(env), resolved.slice(2));
  }
  return resolved;
}

function resolveBearerToken(
  definition: Pick<PiMcpServerEntry, 'bearerToken' | 'bearerTokenEnv'>,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (definition.bearerToken !== undefined) return interpolateEnvVars(definition.bearerToken, env);
  return definition.bearerTokenEnv === undefined ? undefined : env[definition.bearerTokenEnv];
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined || typeof value !== 'object') {
    const serialized = JSON.stringify(value);
    return serialized ?? 'undefined';
  }
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    .join(',')}}`;
}

function toProvenance(source: Omit<PiConfigSource, 'raw'>): PiSourceProvenance {
  return { id: source.id, path: source.path, scope: source.scope, kind: source.kind };
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
  );
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

export function defaultPiExpectedConfig(input: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  opensquidRoot?: string;
  enabledOptional?: ReadonlySet<string>;
}): PiExpectedMcpConfig {
  return buildExpectedPiMcpConfig({
    path: resolvePiGlobalMcpConfigPath(input.env),
    ...(input.opensquidRoot === undefined ? {} : { opensquidRoot: input.opensquidRoot }),
    ...(input.enabledOptional === undefined ? {} : { enabledOptional: input.enabledOptional }),
  });
}

export function catalogCanonicalNames(
  catalog: readonly PiToolCapability[],
): ReadonlyMap<string, string> {
  return new Map(catalog.map((tool) => [tool.name, tool.canonicalPolicyName]));
}
