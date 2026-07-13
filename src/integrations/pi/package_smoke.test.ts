import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, extname, join, posix, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

interface PackageJsonShape {
  readonly files?: readonly string[];
  readonly scripts?: Readonly<Record<string, string>>;
}

const REPO_ROOT = process.cwd();
const REQUIRED_BUILD_FILES = [
  'dist/integrations/pi/runtime.js',
  'dist/integrations/pi/bootstrap.js',
  'dist/integrations/pi/pi_subagent_launcher.js',
  'dist/integrations/pi/projector.js',
  'dist/integrations/pi/spawn_subagent.js',
  'dist/runtime/ralph/harnesses/pi_lap_harness.js',
  'context/pi-system-prompt.md',
] as const;
const CLOSURE_ENTRYPOINTS = [
  'dist/integrations/pi/runtime.js',
  'dist/integrations/pi/projector.js',
  'dist/integrations/pi/spawn_subagent.js',
] as const;
const FORBIDDEN_SCRIPT_PATTERNS = [
  /PI_LIVE_ACCEPTANCE/u,
  /pi-harness-live/u,
  /\bpi\b\s+--/u,
] as const;
const STATIC_RELATIVE_IMPORT =
  /\bimport\s*(?:[^'"`]*?from\s*)?['"](\.[^'"`]+)['"]|\bexport\s+[^'"`]*?from\s*['"](\.[^'"`]+)['"]|\bimport\(\s*['"](\.[^'"`]+)['"]\s*\)/gu;

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function assertBuildArtifactsPresent(): Promise<void> {
  const missing = [] as string[];
  for (const relativePath of REQUIRED_BUILD_FILES) {
    if (!(await pathExists(join(REPO_ROOT, relativePath)))) missing.push(relativePath);
  }
  if (missing.length > 0) {
    throw new Error(
      `Build artifacts absent for package smoke: ${missing.join(', ')}. Run \`pnpm build\` before this test.`,
    );
  }
}

async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const absolute = join(root, entry.name);
    if (entry.isDirectory()) out.push(...(await walkFiles(absolute)));
    else if (entry.isFile()) out.push(absolute);
  }
  return out;
}

function toPackagePath(absolute: string): string {
  return posix.normalize(
    absolute
      .slice(REPO_ROOT.length + 1)
      .split(/\\/u)
      .join('/'),
  );
}

async function projectPackagedFiles(files: readonly string[]): Promise<Set<string>> {
  const packaged = new Set<string>(['package.json', 'README.md', 'LICENSE']);
  for (const entry of files) {
    const absolute = join(REPO_ROOT, entry);
    const info = await stat(absolute);
    if (info.isDirectory()) {
      for (const child of await walkFiles(absolute)) packaged.add(toPackagePath(child));
      continue;
    }
    if (info.isFile()) packaged.add(toPackagePath(absolute));
  }
  return packaged;
}

function parseRelativeImports(source: string): string[] {
  const imports: string[] = [];
  for (const match of source.matchAll(STATIC_RELATIVE_IMPORT)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier !== undefined) imports.push(specifier);
  }
  return imports;
}

async function resolveImportedFile(fromPackagePath: string, specifier: string): Promise<string> {
  const fromDir = dirname(join(REPO_ROOT, fromPackagePath));
  const absoluteBase = resolve(fromDir, specifier);
  const candidates =
    extname(absoluteBase) === ''
      ? [absoluteBase, `${absoluteBase}.js`, join(absoluteBase, 'index.js')]
      : [absoluteBase];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return toPackagePath(candidate);
  }
  throw new Error(`Compiled import target missing on disk: ${fromPackagePath} -> ${specifier}`);
}

async function assertImportClosurePackaged(
  entrypoint: string,
  packaged: ReadonlySet<string>,
  visited: Set<string> = new Set<string>(),
): Promise<void> {
  if (visited.has(entrypoint)) return;
  visited.add(entrypoint);
  if (!packaged.has(entrypoint)) {
    throw new Error(`Packaged closure missing entry ${entrypoint}`);
  }
  const source = await readFile(join(REPO_ROOT, entrypoint), 'utf8');
  for (const specifier of parseRelativeImports(source)) {
    const resolved = await resolveImportedFile(entrypoint, specifier);
    if (!packaged.has(resolved)) {
      throw new Error(
        `Compiled import target is not packaged: ${entrypoint} -> ${specifier} (${resolved})`,
      );
    }
    await assertImportClosurePackaged(resolved, packaged, visited);
  }
}

describe('Pi package artifact layout (no Pi process)', () => {
  it('keeps runtime assets, excludes sources/tests, and leaves live acceptance out of scripts and CI', async () => {
    await assertBuildArtifactsPresent();
    const pkg = JSON.parse(
      await readFile(join(REPO_ROOT, 'package.json'), 'utf8'),
    ) as PackageJsonShape;
    const packaged = await projectPackagedFiles(pkg.files ?? []);

    for (const relativePath of REQUIRED_BUILD_FILES) {
      expect(packaged.has(relativePath)).toBe(true);
    }
    expect(packaged.has('src/integrations/pi/package_smoke.test.ts')).toBe(false);
    expect(packaged.has('dist/integrations/pi/live_acceptance.js')).toBe(false);
    expect(packaged.has('test/e2e/drift-prevention.e2e.test.ts')).toBe(false);
    expect([...packaged].some((path) => path.startsWith('src/'))).toBe(false);

    for (const entrypoint of CLOSURE_ENTRYPOINTS) {
      await assertImportClosurePackaged(entrypoint, packaged);
    }

    const ci = await readFile(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
    const prepush = await readFile(join(REPO_ROOT, 'scripts/pre-push.sh'), 'utf8');
    const scriptSurface = [...Object.values(pkg.scripts ?? {}), ci, prepush].join('\n');
    for (const pattern of FORBIDDEN_SCRIPT_PATTERNS) {
      expect(scriptSurface).not.toMatch(pattern);
    }
    expect(scriptSurface).not.toContain('scripts/acceptance/pi-harness-live.ts');
  });
});
