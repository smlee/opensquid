/**
 * Bundled-binary resolver for the loop-engine subprocess.
 *
 * Pattern: esbuild / biomejs / swc — main opensquid package would declare
 * 6 platform-specific packages as `optionalDependencies`; each one ships
 * a single binary at `bin/loop-engine` (or `.exe` on Windows). npm's
 * `os`/`cpu` fields cause wrong-platform packages to skip install, so on
 * any given host exactly one optional dep is present and provides the
 * right binary.
 *
 * NOTE: opensquid 0.5.108 ships LOCAL-BUILD ONLY (per T.1.J §10). The
 * `optionalDependencies` block is not yet declared in package.json — npm
 * stubs land in a follow-up track. This resolver returns `null` on every
 * call until then, and callers fall through to `config.ts` dev-path +
 * `$PATH` discovery. The mapping table is kept now so the wiring is
 * already correct when stubs land.
 *
 * Runtime path:
 *   1. Map `(process.platform, process.arch)` → optional-dep name.
 *   2. Try `createRequire(import.meta.url).resolve(...)` on that
 *      package's package.json. Returns `<dir>/bin/<name>` if installed.
 *   3. If not installed (npm `--no-optional`, wrong-platform install,
 *      local pre-publish dev), return `null`. Caller falls back to the
 *      dev-path + $PATH chain in `config.ts`.
 *
 * Resolution is synchronous + side-effect-free.
 */

import { createRequire } from 'node:module';
import * as path from 'node:path';

type PlatformKey =
  | 'darwin-x64'
  | 'darwin-arm64'
  | 'linux-x64'
  | 'linux-arm64'
  | 'win32-x64'
  | 'win32-arm64';

/**
 * Supported targets and their optional-dep package names. Stays in sync
 * with `optionalDependencies` in package.json (when added) and with the
 * loop-engine release matrix. If you change any of those, change all.
 */
const PACKAGE_FOR_PLATFORM: Record<PlatformKey, string> = {
  'darwin-x64': 'opensquid-engine-darwin-x64',
  'darwin-arm64': 'opensquid-engine-darwin-arm64',
  'linux-x64': 'opensquid-engine-linux-x64',
  'linux-arm64': 'opensquid-engine-linux-arm64',
  'win32-x64': 'opensquid-engine-win32-x64',
  'win32-arm64': 'opensquid-engine-win32-arm64',
};

const BIN_NAME_FOR_PLATFORM: Record<PlatformKey, string> = {
  'darwin-x64': 'loop-engine',
  'darwin-arm64': 'loop-engine',
  'linux-x64': 'loop-engine',
  'linux-arm64': 'loop-engine',
  'win32-x64': 'loop-engine.exe',
  'win32-arm64': 'loop-engine.exe',
};

export interface PlatformProbe {
  platform: NodeJS.Platform;
  arch: string;
}

/**
 * Compute the (platform, arch) tuple for the current process. Wrapped
 * for unit testability — tests inject a synthetic probe.
 */
export function currentPlatform(): PlatformProbe {
  return { platform: process.platform, arch: process.arch };
}

/**
 * Look up the optional-dep package name for a given platform. Returns
 * `null` when the (platform, arch) pair isn't in the supported matrix.
 */
export function packageForPlatform(probe: PlatformProbe): string | null {
  const key = `${probe.platform}-${probe.arch}` as PlatformKey;
  return PACKAGE_FOR_PLATFORM[key] ?? null;
}

/**
 * Look up the binary filename for a given platform (`.exe` on Windows).
 */
export function binaryNameForPlatform(probe: PlatformProbe): string | null {
  const key = `${probe.platform}-${probe.arch}` as PlatformKey;
  return BIN_NAME_FOR_PLATFORM[key] ?? null;
}

/**
 * Resolve the bundled binary path via the optional-dep mechanism.
 *
 * Returns `null` when:
 *   - the current (platform, arch) isn't in the supported matrix,
 *   - the optional dep isn't installed (pre-publish dev, npm
 *     `--no-optional`, wrong-platform install), or
 *   - the dep is installed but the expected `bin/<name>` file is missing
 *     (broken publish — diagnostic-only; caller falls through).
 *
 * v0.6c audit fix: use `path.dirname + path.join` not string slice — on
 * Windows `require.resolve` returns `\` separators; slicing on the
 * `"/package.json".length` suffix would silently mis-strip and the
 * concatenation would mix separators.
 */
export function resolveBundledEngineBin(probe: PlatformProbe = currentPlatform()): string | null {
  const pkg = packageForPlatform(probe);
  const binName = binaryNameForPlatform(probe);
  if (!pkg || !binName) return null;

  const req = createRequire(import.meta.url);
  try {
    const pkgJson = req.resolve(`${pkg}/package.json`);
    return path.join(path.dirname(pkgJson), 'bin', binName);
  } catch {
    // MODULE_NOT_FOUND — optional dep not installed for this host.
    return null;
  }
}
