/**
 * Phase 1 capstone — end-to-end runtime smoke test.
 *
 * Proves the substrate wires together: a fixture pack with a `never-amend`
 * rule is dispatched through the real compiled hook binary (`pre-tool-use.js`)
 * launched as a subprocess. The block path returns exit code 2 with a stderr
 * message; the allow path returns exit code 0 with empty stderr.
 *
 * Why a subprocess (not in-process): the Claude Code hook protocol is a
 * subprocess contract — Claude Code spawns `opensquid-hook-pretooluse` with
 * stdin = tool-call JSON and reads exit code + stderr. Testing in-process
 * would short-circuit the whole hook surface. The subprocess test is the
 * only one that proves "Claude Code → opensquid → block decision" works.
 *
 * Pack injection seam (Phase 1 only — deleted in Phase 2):
 *   The child subprocess has its own module state, so `setActivePacks` in
 *   this parent test process is invisible to the child. Bootstrap reads
 *   `OPENSQUID_TEST_PACK` env var at module-load time when it's set;
 *   that's how the never-amend pack reaches the child. See bootstrap.ts
 *   header for the seam's design rationale.
 *
 * Build prerequisite: the test reads `dist/runtime/hooks/pre-tool-use.js`,
 * which `pnpm build` produces. `beforeAll` invokes `pnpm build` (synchronously
 * in the child process) so the test is self-contained — a clean checkout
 * plus `pnpm test` works without a manual build step. The build is cheap
 * (~3s) and runs once per test file.
 *
 * Hermeticity: the never-amend pack uses only `match_command` + `verdict`
 * primitives — both pure functions over in-memory Event state. No Ollama,
 * no `claude` CLI, no libsql, no network. The subprocess inherits an env
 * scrubbed of `CLAUDE_SESSION_ID` (would otherwise leak into pack scoping).
 */

import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { neverAmendPack } from '../fixtures/test-pack.js';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const HOOK_BIN = resolve(REPO_ROOT, 'dist', 'runtime', 'hooks', 'pre-tool-use.js');
const HOOK_TIMEOUT_MS = 10_000;

beforeAll(() => {
  // Rebuild so dist/ matches the current src/ (bootstrap.ts in particular).
  // `pnpm build` is the contract documented in package.json — using it here
  // (rather than calling `tsc` directly) means any future build-script
  // change is honored automatically.
  const built = spawnSync('pnpm', ['build'], { cwd: REPO_ROOT, stdio: 'pipe' });
  if (built.status !== 0) {
    throw new Error(
      `pnpm build failed before smoke test:\n${built.stdout.toString()}\n${built.stderr.toString()}`,
    );
  }
}, 60_000);

interface HookResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

function runHook(payload: Record<string, unknown>, env: NodeJS.ProcessEnv): Promise<HookResult> {
  return new Promise((resolveResult, rejectResult) => {
    const proc = spawn('node', [HOOK_BIN], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    let stderr = '';
    let stdout = '';
    proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    proc.stdout.on('data', (d: Buffer) => (stdout += d.toString()));

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      rejectResult(new Error(`Hook subprocess timed out after ${String(HOOK_TIMEOUT_MS)}ms`));
    }, HOOK_TIMEOUT_MS);

    proc.on('error', (e) => {
      clearTimeout(timer);
      rejectResult(e);
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolveResult({ exitCode: code ?? -1, stderr, stdout });
    });

    proc.stdin.write(JSON.stringify(payload));
    proc.stdin.end();
  });
}

function envWithPack(pack: unknown): NodeJS.ProcessEnv {
  // Inherit PATH/HOME/etc. so `node` resolves, but strip CLAUDE_SESSION_ID
  // (would scope pack loading in Phase 2 and leaks parent intent). Inject
  // OPENSQUID_TEST_PACK as the seam.
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CLAUDE_SESSION_ID;
  env.OPENSQUID_TEST_PACK = JSON.stringify(pack);
  return env;
}

describe('runtime smoke (subprocess hook + fixture pack)', () => {
  it('blocks git commit --amend with exit code 2 + stderr', async () => {
    const result = await runHook(
      { tool: 'Bash', args: { command: 'git commit --amend -m "oops"' } },
      envWithPack(neverAmendPack),
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/amend/i);
  });

  it('allows safe git commands with exit code 0 + empty stderr', async () => {
    const result = await runHook(
      { tool: 'Bash', args: { command: 'git status' } },
      envWithPack(neverAmendPack),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('allows everything when no pack is injected', async () => {
    // No OPENSQUID_TEST_PACK in env → loadFromEnv returns []. Proves the
    // empty-active-packs path of the dispatcher (Phase 1 default state).
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.CLAUDE_SESSION_ID;
    delete env.OPENSQUID_TEST_PACK;
    const result = await runHook(
      { tool: 'Bash', args: { command: 'git commit --amend -m "oops"' } },
      env,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
  });
});
