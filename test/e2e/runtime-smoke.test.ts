/**
 * Phase 2 capstone — end-to-end runtime smoke test (on-disk YAML pack).
 *
 * Proves the substrate wires together when a real on-disk YAML pack is
 * loaded by `loadPack` and dispatched through the compiled hook binary
 * (`pre-tool-use.js`) launched as a subprocess. Same assertions as the
 * Phase-1 version (Task 1.19): block path returns exit code 2 with a
 * stderr message; allow path returns exit code 0 with empty stderr.
 *
 * Why on-disk YAML (replaces Phase-1 inline `neverAmendPack`):
 *   The Phase-2 contract is that packs are folders on disk parsed via
 *   `src/packs/loader.ts`. The smoke test that proves end-to-end runtime
 *   wiring has to exercise that contract — otherwise we'd be testing a
 *   bypass path that ships nothing real to users. The fixture pack at
 *   `test/fixtures/packs/smoke/` is intentionally minimal so it doubles
 *   as a copy-pasteable onboarding example (4-field manifest + one skill).
 *
 * Why a subprocess (not in-process): the Claude Code hook protocol is a
 * subprocess contract — Claude Code spawns `opensquid-hook-pretooluse` with
 * stdin = tool-call JSON and reads exit code + stderr. Testing in-process
 * would short-circuit the whole hook surface.
 *
 * Pack injection seam (`OPENSQUID_TEST_PACK_DIR`):
 *   The child subprocess has its own module state, so a parent `loadPack`
 *   call is invisible to it. Bootstrap reads `OPENSQUID_TEST_PACK_DIR` at
 *   module-load time and runs the real `loadPack` against it. The legacy
 *   `OPENSQUID_TEST_PACK` JSON seam stays in bootstrap for any in-flight
 *   tests that hand-build a pack — see bootstrap.ts header for both seams.
 *   We pass an absolute path so the child's cwd (inherited from this test
 *   process, but a future runner may change cwd) doesn't matter.
 *
 * Build prerequisite: the test reads `dist/runtime/hooks/pre-tool-use.js`,
 * which `pnpm build` produces. `beforeAll` invokes `pnpm build` (synchronously
 * in the child process) so the test is self-contained.
 *
 * Hermeticity: the smoke pack uses only `match_command` + `verdict`
 * primitives — both pure functions over in-memory Event state. No Ollama,
 * no `claude` CLI, no libsql, no network. The subprocess inherits an env
 * scrubbed of `CLAUDE_SESSION_ID`.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const HOOK_BIN = resolve(REPO_ROOT, 'dist', 'runtime', 'hooks', 'pre-tool-use.js');
const SMOKE_PACK_DIR = resolve(REPO_ROOT, 'test', 'fixtures', 'packs', 'smoke');
const HOOK_TIMEOUT_MS = 10_000;

beforeAll(() => {
  // The fixture pack folder must exist before we let `pnpm build` run — a
  // missing folder would surface as a confusing "no skills loaded" silent
  // pass downstream. Failing here points the developer straight at the
  // fixture, not at the hook binary or the runtime.
  if (!existsSync(SMOKE_PACK_DIR)) {
    throw new Error(`smoke pack fixture missing at ${SMOKE_PACK_DIR}`);
  }

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

function envWithSmokePack(): NodeJS.ProcessEnv {
  // Inherit PATH/HOME/etc. so `node` resolves, but strip CLAUDE_SESSION_ID
  // (would scope pack loading and leaks parent intent). Inject the on-disk
  // pack folder via the OPENSQUID_TEST_PACK_DIR seam.
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CLAUDE_SESSION_ID;
  delete env.OPENSQUID_TEST_PACK;
  env.OPENSQUID_TEST_PACK_DIR = SMOKE_PACK_DIR;
  // G.2: silence the dispatch-trace marker so the "empty stderr on allow"
  // assertions stay valid. The marker is diagnostic, not drift output —
  // its presence/absence is asserted in hooks.bin.integration.test.ts
  // (the regression net for the silent-no-op failure mode). Existing
  // contracts here are about "no drift message", which is orthogonal.
  env.OPENSQUID_DISPATCH_TRACE = '0';
  return env;
}

describe('runtime smoke (subprocess hook + on-disk YAML pack)', () => {
  it('blocks git commit --amend via a permissionDecision:deny envelope (FU.11)', async () => {
    // FU.11: a block is now signalled as a PreToolUse `permissionDecision:"deny"`
    // JSON envelope (exit 0), NOT a bare exit 2 — exit 2 is silently ignored
    // under `--dangerously-skip-permissions`, the deny envelope is honored.
    const result = await runHook(
      { tool: 'Bash', args: { command: 'git commit --amend -m "oops"' } },
      envWithSmokePack(),
    );
    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/amend/i);
  });

  it('allows safe git commands with exit code 0 + empty stderr', async () => {
    const result = await runHook(
      { tool: 'Bash', args: { command: 'git status' } },
      envWithSmokePack(),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('allows everything when no pack is injected', async () => {
    // No OPENSQUID_TEST_PACK / OPENSQUID_TEST_PACK_DIR in env → both seams
    // return []. Proves the empty-active-packs path of the dispatcher
    // (default state when no pack is configured).
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.CLAUDE_SESSION_ID;
    delete env.OPENSQUID_TEST_PACK;
    delete env.OPENSQUID_TEST_PACK_DIR;
    env.OPENSQUID_DISPATCH_TRACE = '0'; // G.2: see envWithSmokePack note.
    const result = await runHook(
      { tool: 'Bash', args: { command: 'git commit --amend -m "oops"' } },
      env,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
  });
});
