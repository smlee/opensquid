import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runOneShotCli } from '../../runtime/spawn_lifecycle.js';
import { resolvePiAdapterEntry, resolvePiManagedNpmPackageDir } from './paths.js';

export const PI_MCP_ADAPTER_PACKAGE = 'pi-mcp-adapter';

export interface EnsurePiAdapterInput {
  cli: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export interface EnsurePiAdapterDeps {
  readText(path: string): Promise<string>;
  runPi(args: readonly string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): Promise<void>;
}

export interface EnsurePiAdapterResult {
  adapterEntry: string;
  packageDir: string;
  version: string;
  installed: boolean;
}

const INSTALL_TIMEOUT_MS = 60_000;

const defaultDepsForCli = (cli: string): EnsurePiAdapterDeps => ({
  readText: (path) => readFile(path, 'utf8'),
  runPi: async (args, opts) => {
    await runOneShotCli({
      cli,
      args: [...args],
      cwd: opts.cwd,
      env: opts.env,
      prompt: '',
      timeoutMs: INSTALL_TIMEOUT_MS,
      errorPrefix: 'pi install ',
      timeoutError: (timeoutMs) => new Error(`pi install timeout after ${timeoutMs}ms`),
    });
  },
});

async function readInstalledVersion(
  packageDir: string,
  deps: EnsurePiAdapterDeps,
): Promise<string | null> {
  try {
    const raw = await deps.readText(join(packageDir, 'package.json'));
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' && parsed.version.trim() !== ''
      ? parsed.version
      : null;
  } catch {
    return null;
  }
}

/** Ensure the adapter exists; behavioral probes, not its version string, establish compatibility. */
export async function ensurePiAdapter(
  input: EnsurePiAdapterInput,
  deps: EnsurePiAdapterDeps = defaultDepsForCli(input.cli),
): Promise<EnsurePiAdapterResult> {
  const env = { ...process.env, ...(input.env ?? {}) };
  const packageDir = resolvePiManagedNpmPackageDir(PI_MCP_ADAPTER_PACKAGE, env);
  const before = await readInstalledVersion(packageDir, deps);
  if (before === null) {
    await deps.runPi(['install', `npm:${PI_MCP_ADAPTER_PACKAGE}`], {
      cwd: input.cwd,
      env,
    });
  }
  const after = await readInstalledVersion(packageDir, deps);
  if (after === null) {
    throw new Error(
      `${PI_MCP_ADAPTER_PACKAGE} is unavailable in ${packageDir} after Pi installation`,
    );
  }
  return {
    adapterEntry: resolvePiAdapterEntry(PI_MCP_ADAPTER_PACKAGE, env),
    packageDir,
    version: after,
    installed: before === null,
  };
}
