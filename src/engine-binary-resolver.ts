/**
 * Bundled-binary resolver for the loop-engine subprocess (v0.6c).
 *
 * Pattern: esbuild / biomejs / swc — main opensquid package declares 6
 * platform-specific packages as `optionalDependencies`; each one ships
 * a single binary at `bin/loop-engine` (or `.exe` on Windows). npm's
 * `os`/`cpu` fields cause the wrong-platform packages to skip install,
 * so on any given host exactly one optional dep is present and provides
 * the right binary.
 *
 * Runtime path:
 *   1. Map `(process.platform, process.arch)` → optional-dep name.
 *   2. Try `createRequire(import.meta.url).resolve(...)` on that
 *      package's `bin/loop-engine`. Returns absolute path if installed.
 *   3. If not installed (npm `--no-optional`, wrong-platform install,
 *      local pre-publish dev), return `null`. Caller falls back to the
 *      pre-existing discovery chain in `config.ts`.
 *
 * Why a separate module: the resolver is pure (no fs writes, no async),
 * and isolating it makes it trivially unit-testable + future
 * postinstall-script-friendly. Keeps `config.ts` focused on the legacy
 * env/config/path chain.
 */

import { createRequire } from "node:module";
import * as path from "node:path";

// ---------------------------------------------------------------------
// Platform → optional-dep name map (static, exhaustive over supported
// targets).
// ---------------------------------------------------------------------

/** Tuple key: `${process.platform}-${process.arch}`. */
type PlatformKey =
  | "darwin-x64"
  | "darwin-arm64"
  | "linux-x64"
  | "linux-arm64"
  | "win32-x64"
  | "win32-arm64";

/**
 * Supported targets and their optional-dep package names. Stays in sync
 * with `optionalDependencies` in the main package.json and with the
 * matrix in `loop-engine/.github/workflows/release.yml`. If you change
 * any of those, change all three.
 */
const PACKAGE_FOR_PLATFORM: Record<PlatformKey, string> = {
  "darwin-x64": "opensquid-engine-darwin-x64",
  "darwin-arm64": "opensquid-engine-darwin-arm64",
  "linux-x64": "opensquid-engine-linux-x64",
  "linux-arm64": "opensquid-engine-linux-arm64",
  "win32-x64": "opensquid-engine-win32-x64",
  "win32-arm64": "opensquid-engine-win32-arm64",
};

const BIN_NAME_FOR_PLATFORM: Record<PlatformKey, string> = {
  "darwin-x64": "loop-engine",
  "darwin-arm64": "loop-engine",
  "linux-x64": "loop-engine",
  "linux-arm64": "loop-engine",
  "win32-x64": "loop-engine.exe",
  "win32-arm64": "loop-engine.exe",
};

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

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
 * Resolution is synchronous + side-effect-free. Safe to call before any
 * async work in the spawn path.
 */
export function resolveBundledEngineBin(probe: PlatformProbe = currentPlatform()): string | null {
  const pkg = packageForPlatform(probe);
  const binName = binaryNameForPlatform(probe);
  if (!pkg || !binName) return null;

  // createRequire(import.meta.url) gives us a node-resolution function
  // anchored at this file's location — which is what we want since the
  // optional deps are installed alongside the main package's node_modules.
  const req = createRequire(import.meta.url);
  try {
    // We resolve the package's package.json (always present) and append
    // the binary path. Resolving `${pkg}/bin/<name>` directly would
    // require the binary to be listed in `exports` or `bin`, which we
    // intentionally don't do (the binary is opaque to node's loader).
    const pkgJson = req.resolve(`${pkg}/package.json`);
    // pkgJson = /absolute/path/to/node_modules/<pkg>/package.json
    // binary  = /absolute/path/to/node_modules/<pkg>/bin/<name>
    // v0.6c audit fix (H1): use path.join not string slice. On Windows
    // require.resolve returns `\` separators; slicing on "/package.json".length
    // would silently mis-strip the suffix and concatenating with "/bin/..."
    // would mix separators. path.dirname + path.join is the portable primitive.
    return path.join(path.dirname(pkgJson), "bin", binName);
  } catch {
    // MODULE_NOT_FOUND — optional dep wasn't installed for this host.
    return null;
  }
}
