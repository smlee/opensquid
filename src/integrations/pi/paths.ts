import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const resolvedHome = (env: NodeJS.ProcessEnv): string => env.HOME?.trim() ?? homedir();

export function resolvePiAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = resolvedHome(env);
  const configured = env.PI_CODING_AGENT_DIR?.trim();
  if (!configured) return join(home, '.pi', 'agent');
  if (configured === '~') return home;
  if (configured.startsWith('~/')) return resolve(home, configured.slice(2));
  return resolve(configured);
}

export function resolvePiAgentPath(
  env: NodeJS.ProcessEnv = process.env,
  ...segments: string[]
): string {
  return join(resolvePiAgentDir(env), ...segments);
}

export function resolvePiGlobalSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolvePiAgentPath(env, 'settings.json');
}

export function resolvePiGlobalMcpConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolvePiAgentPath(env, 'mcp.json');
}

export function resolvePiMetadataCachePath(env: NodeJS.ProcessEnv = process.env): string {
  return resolvePiAgentPath(env, 'mcp-cache.json');
}

export function resolveSharedGlobalMcpConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolvedHome(env), '.config', 'mcp', 'mcp.json');
}

export function resolveProjectMcpConfigPath(cwd: string): string {
  return resolve(cwd, '.mcp.json');
}

export function resolveProjectPiMcpConfigPath(cwd: string): string {
  return resolve(cwd, '.pi', 'mcp.json');
}

export function resolvePiManagedNpmPackageDir(
  packageName: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolvePiAgentPath(env, 'npm', 'node_modules', packageName);
}

export function resolvePiAdapterEntry(
  packageName = 'pi-mcp-adapter',
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(resolvePiManagedNpmPackageDir(packageName, env), 'index.ts');
}
