/**
 * Bundled-default codex loader (drift-as-codex chunk 2).
 *
 * Reads `bundled-default/codex.yaml` once per process and returns the
 * parsed FocusedCodex. Downstream hooks (workflow-gate, honesty-ledger,
 * versioning-gate — see chunks 3a/3b) call this to source their rules
 * from the codex instead of having them hard-coded in TypeScript.
 *
 * Singleton cache: the YAML is small and unchanging across a process
 * lifetime; computing the path + parsing once is cheap and avoids
 * surprising the test suite with stale state.
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { parseCodexYaml } from "./parse.js";
import { FocusedCodex, isFocusedCodex } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Path to the bundled-default codex YAML. Resolved relative to this
 * file's location, so it works in both `src/` (vitest direct execution)
 * and `dist/` (built + published npm package, since
 * `src/codex/bundled-default/codex.yaml` is listed in `package.json`
 * `files[]`).
 *
 * The relative layout is identical in both worlds:
 *   src/codex/loader.ts + src/codex/bundled-default/codex.yaml
 *   dist/codex/loader.js + src/codex/bundled-default/codex.yaml
 *
 * Wait — the `dist/` build only includes the loader.js. The YAML
 * stays at its `src/codex/bundled-default/codex.yaml` location because
 * that's what package.json `files[]` ships. We resolve from
 * `loader.{ts,js}` up to the package root then back down to the YAML.
 */
function resolveBundledCodexPath(): string {
  // From `dist/codex/loader.js` or `src/codex/loader.ts`, the YAML is
  // at `../../src/codex/bundled-default/codex.yaml` relative to the
  // dist build, or `./bundled-default/codex.yaml` in the src tree.
  // Try the src-tree path first (works in test runs); fall back to
  // the dist-relative path (works in published npm package).
  const srcRelative = path.resolve(__dirname, "bundled-default", "codex.yaml");
  // Distinguish dist vs src by checking whether __dirname ends with
  // .../dist/codex. In `dist/`, the bundled YAML is one level higher.
  const distRelative = path.resolve(
    __dirname,
    "..",
    "..",
    "src",
    "codex",
    "bundled-default",
    "codex.yaml",
  );
  // When running from src/, srcRelative resolves correctly; when
  // running from dist/, only distRelative does (the YAML stays in
  // src/codex/bundled-default/ per package.json files[]). Branch on
  // whether __dirname is inside /dist/.
  return srcRelative.includes(`${path.sep}dist${path.sep}`) ? distRelative : srcRelative;
}

let cachedCodex: FocusedCodex | null = null;

/**
 * Load the bundled-default codex once per process and return it.
 *
 * Throws if the file is missing, malformed, or parses to a
 * CompositeCodex (the bundled-default is always focused — composite
 * codexes are a separate consumer pattern).
 */
export function loadBundledDefaultCodex(): FocusedCodex {
  if (cachedCodex !== null) {
    return cachedCodex;
  }
  const yamlPath = resolveBundledCodexPath();
  let yaml: string;
  try {
    yaml = readFileSync(yamlPath, "utf-8");
  } catch (err) {
    throw new Error(
      `[opensquid loader] bundled-default codex not found at ${yamlPath}: ${err instanceof Error ? err.message : err}`,
    );
  }
  const parsed = parseCodexYaml(yaml);
  if (!isFocusedCodex(parsed)) {
    throw new Error(
      `[opensquid loader] bundled-default codex must be focused, got composite (id=${parsed.id})`,
    );
  }
  cachedCodex = parsed;
  return cachedCodex;
}

/**
 * Clear the loader cache. Test-only — production code should never
 * need to invalidate the bundled-default codex within a process.
 */
export function __resetCachedCodexForTesting(): void {
  cachedCodex = null;
}
