/**
 * Shared fixture builders for the G.13 end-to-end drift-prevention test.
 *
 * Each builder is a single-purpose helper composed by
 * `drift-prevention.e2e.test.ts`. Builders never spawn the engine — that's
 * the test file's `beforeAll` job (shared across scenarios). They also do
 * NOT touch the user's real `~/.opensquid` or `~/.claude` directories —
 * tests pass per-scenario tmp directories instead.
 *
 * Three categories of helper:
 *
 *  1. Hook-bin runners (`spawnHookBin`) — spawn the compiled
 *     `dist/runtime/hooks/<event>.js` binaries with canonical Claude Code
 *     wire payloads on stdin. Returns `{ exitCode, stdout, stderr }` so
 *     scenarios can assert on the JSON envelope (G.4) or the
 *     `[opensquid-dispatch]` marker (G.2) without managing child-process
 *     plumbing per test.
 *
 *  2. Auto-memory fixture builders (`buildAutoMemoryDir`) — drops N
 *     deterministically-shaped `.md` files into a tmpdir so the G.6
 *     scenario can exercise `importAutoMemoryDir` against a real tree.
 *
 *  3. Pack-source builders (`buildSangminPack`) — projects the G.4 / G.5
 *     / G.7 / G.12 skill YAML into a temp `<scope>/packs/<name>/`
 *     layout + an `active.json` so the hook bins' real on-disk loader
 *     path picks them up. We could synthesize the YAML inline, but
 *     reading the user's existing canonical YAML keeps the E2E pinned to
 *     production fidelity — if the user edits a skill, the E2E catches
 *     downstream behavior shifts.
 *
 * No mocks. Real fs, real spawn, real engine connection — the entire
 * point of G.13 is to exercise the integration seams that unit tests
 * cannot cover.
 *
 * Size discipline (G.13 spec): keep this file <= 200 LOC. Anything
 * scenario-specific belongs in the test file itself.
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, '../../..');
export const DIST_HOOKS = resolve(REPO_ROOT, 'dist/runtime/hooks');

export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn a compiled hook bin with the given stdin payload. Inherits env so
 * the caller's OPENSQUID_HOME / OPENSQUID_AUTOMATION / etc. flow through.
 * Adds `OPENSQUID_DISPATCH_TRACE=1` to force the G.2 marker on (the test
 * env may have other tests' cleanup blowing it away).
 */
export async function spawnHookBin(
  binName: string,
  stdinJson: string,
  extraEnv: Record<string, string> = {},
  timeoutMs = 15_000,
): Promise<SpawnResult> {
  const binPath = resolve(DIST_HOOKS, binName);
  if (!existsSync(binPath)) {
    throw new Error(`E2E: compiled hook bin missing at ${binPath}; run pnpm build first`);
  }
  return new Promise((res, rej) => {
    const env = { ...process.env, OPENSQUID_DISPATCH_TRACE: '1', ...extraEnv };
    const p = spawn('node', [binPath], { stdio: ['pipe', 'pipe', 'pipe'], env });
    let stdout = '';
    let stderr = '';
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        try {
          p.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        rej(new Error(`E2E: hook ${binName} timed out after ${String(timeoutMs)}ms`));
      }
    }, timeoutMs);
    p.stdout.on('data', (b: Buffer) => (stdout += b.toString('utf8')));
    p.stderr.on('data', (b: Buffer) => (stderr += b.toString('utf8')));
    p.on('error', (e) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        rej(e);
      }
    });
    p.on('close', (code) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        res({ exitCode: code ?? -1, stdout, stderr });
      }
    });
    p.stdin.write(stdinJson);
    p.stdin.end();
  });
}

/**
 * Build N auto-memory fixture files in `dir`. Frontmatter shape matches the
 * Zod schema in `setup/migrate/auto_memory_reader.ts`. Returns the
 * basenames for assertion convenience.
 */
export async function buildAutoMemoryDir(dir: string, n: number): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const names: string[] = [];
  for (let i = 0; i < n; i++) {
    const name = `g13-fixture-${String(i).padStart(3, '0')}`;
    const md =
      `---\n` +
      `name: ${name}\n` +
      `description: "G.13 e2e fixture memory ${String(i)} for import-auto dedup test"\n` +
      `metadata:\n` +
      `  type: user\n` +
      `---\n` +
      `Body for ${name}. Content seeded by buildAutoMemoryDir.\n`;
    await writeFile(join(dir, `${name}.md`), md);
    names.push(`${name}.md`);
  }
  return names;
}

/**
 * Project the user's installed `sangmin-personal-rules` pack into a tmp
 * scope root so the hook bins' real on-disk loader picks it up.
 *
 * Copies the four skills the G.13 scenarios exercise (recall-pre-inject,
 * verify-before-citing-memory, prefer-opensquid-memory, d9-guard) plus a
 * minimal manifest.yaml. Writes `<scopeRoot>/active.json` declaring the
 * single pack. Returns the pack folder path for cleanup convenience.
 */
export async function buildSangminPack(scopeRoot: string): Promise<string> {
  const packName = 'sangmin-personal-rules';
  const packDir = join(scopeRoot, 'packs', packName);
  const skillsDir = join(packDir, 'skills');
  await mkdir(skillsDir, { recursive: true });
  await writeFile(
    join(packDir, 'manifest.yaml'),
    [
      `name: ${packName}`,
      `version: 0.0.1`,
      `scope: universal`,
      `goal: G.13 e2e fixture pack`,
      `description: ""`,
      `requires: []`,
      `conflicts: []`,
      `evolves: true`,
      ``,
    ].join('\n'),
  );
  // Source the four skills from the user's installed pack (canonical
  // production fidelity). If a skill is missing on this machine, the
  // scenario test will skip+report rather than silently behave wrong.
  const userPack = join(
    process.env.HOME ?? '/tmp',
    '.opensquid/packs/sangmin-personal-rules/skills',
  );
  const skills = [
    'recall-pre-inject',
    'verify-before-citing-memory',
    'prefer-opensquid-memory',
    'd9-guard',
  ];
  for (const s of skills) {
    const src = join(userPack, s, 'skill.yaml');
    if (!existsSync(src)) continue;
    const dst = join(skillsDir, s);
    await mkdir(dst, { recursive: true });
    await writeFile(join(dst, 'skill.yaml'), await readFile(src, 'utf8'));
  }
  await writeFile(join(scopeRoot, 'active.json'), JSON.stringify({ packs: [packName] }, null, 2));
  return packDir;
}
