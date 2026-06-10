/**
 * G.2 Layer 1 — Hook bin "no silent no-op" regression test.
 *
 * This test exists for ONE reason: catch the G.1 root-cause failure mode in
 * CI. That bug was a hook entry whose `command` resolved to a built dist file
 * that compiled cleanly, exited 0, but ran ZERO dispatch logic. The user's
 * hooks looked "configured" but did nothing. The hooks.integration.test.ts
 * sibling spawns SOURCE via tsx (fast iteration) — that test cannot catch
 * stale-dist or build-output regressions. THIS test spawns the COMPILED
 * `dist/runtime/hooks/*.js` binaries and asserts the `[opensquid-dispatch]`
 * marker on stderr.
 *
 * Marker absence == regression. The test message names the failure mode
 * explicitly so the next CI red flag is self-diagnosing.
 *
 * Stale-dist handling: if `dist/runtime/hooks/dispatch.js` is older than its
 * `.ts` source (a stale-cache state local devs hit when running `pnpm test`
 * without first running `pnpm build`), `beforeAll` rebuilds via direct `tsc`
 * invocation. CI always runs `pnpm build` before `pnpm test` per the locked
 * pre-push checklist (memory `feedback_pre_push_checklist`), so this branch
 * is the dev-loop convenience only. Build is gated by a 60s timeout — if
 * it fails or times out, the test surfaces a clear error instead of
 * spinning forever (see `ensureFreshDist`).
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');
const DIST_HOOKS = resolve(REPO_ROOT, 'dist/runtime/hooks');
const SRC_HOOKS = resolve(REPO_ROOT, 'src/runtime/hooks');

interface BinSpec {
  bin: string;
  /** The runtime Event.kind label that the bin normalizes the payload into.
   * Doctor + this test both assert `event=<kind>` matches this. */
  event: string;
  /** Canonical Claude Code wire payload (snake_case fields). */
  stdin: string;
}

const BIN_SPECS: BinSpec[] = [
  {
    bin: 'pre-tool-use.js',
    event: 'tool_call',
    stdin: JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'echo hi' },
      session_id: 'test',
    }),
  },
  {
    // T-POSTPUSH POSTPUSH.1 — post-tool-use bin smoke. Includes a
    // `tool_result` payload to exercise the new event-schema normalization.
    bin: 'post-tool-use.js',
    event: 'post_tool_call',
    stdin: JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'echo hi' },
      tool_result: { exit_code: 0, stdout: 'hi\n' },
      session_id: 'test',
    }),
  },
  {
    bin: 'user-prompt-submit.js',
    event: 'prompt_submit',
    stdin: JSON.stringify({ prompt: 'hello', session_id: 'test' }),
  },
  {
    bin: 'stop.js',
    event: 'stop',
    stdin: JSON.stringify({ session_id: 'test', stop_hook_active: false }),
  },
  {
    bin: 'session-end.js',
    event: 'session_end',
    stdin: JSON.stringify({ session_id: 'test' }),
  },
  {
    // T-HANDOFF-HARDENING HH6.1 — session-start bin smoke. `source: 'startup'`
    // dispatches (emits the marker); the clear/compact short-circuit is
    // covered by its own test below.
    bin: 'session-start.js',
    event: 'session_start',
    stdin: JSON.stringify({ session_id: 'test', source: 'startup' }),
  },
];

beforeAll(() => {
  ensureFreshDist();
}, 90_000);

describe('G.2: hook bins do not silent no-op', () => {
  // T-ASG5 L1+L2: isolate OPENSQUID_HOME so spawned hook binaries write
  // .current-session (and any other session_state writes) into a tmp dir,
  // not the dev's live ~/.opensquid/. The user-prompt-submit.js binary
  // calls recordCurrentSession with the stdin session_id ('test') —
  // pre-T-ASG5 this contaminated the live home, breaking subsequent
  // log_phase MCP calls until manually restored. Pattern lifted verbatim
  // from ASG.1's hooks.integration.test.ts:41-62 (commit 019c728);
  // tmpdir prefix matches so vitest globalSetup teardown also catches
  // any orphaned dirs.
  let tempHome: string;
  let priorHome: string | undefined;

  beforeEach(async () => {
    priorHome = process.env.OPENSQUID_HOME;
    tempHome = await mkdtemp(join(tmpdir(), 'opensquid-hooks-integration-'));
    process.env.OPENSQUID_HOME = tempHome;
  });

  afterEach(async () => {
    if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = priorHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  for (const spec of BIN_SPECS) {
    it(`${spec.bin} emits [opensquid-dispatch] marker on stderr`, async () => {
      const binPath = resolve(DIST_HOOKS, spec.bin);
      expect(existsSync(binPath), `compiled bin missing: ${binPath}`).toBe(true);
      const r = await runBin(binPath, spec.stdin);
      // exit 0 = allow (no packs active in the stub loader path; OK).
      expect(r.exitCode, `hook ${spec.bin} non-zero exit (stderr: ${r.stderr})`).toBe(0);
      expect(
        r.stderr,
        `Hook ${spec.bin} produced no marker — SILENT NO-OP regression (G.1 failure mode). stderr was: ${JSON.stringify(r.stderr)}`,
      ).toContain('[opensquid-dispatch]');
      expect(r.stderr).toContain(`event=${spec.event}`);
      expect(r.stderr).toMatch(/rules=\d+/);
      expect(r.stderr).toMatch(/packs=\d+/);
    }, 20_000);
  }

  // T-ASG5 L5: regression guard — prove the isolation protects the live
  // user home. Reads ~/.opensquid/.current-session via homedir() directly
  // (NOT OPENSQUID_HOME, which we've overridden) before+after spawning
  // user-prompt-submit.js. The spawned bin calls recordCurrentSession
  // with the stdin session_id; pre-T-ASG5 that overwrote the live file
  // with 'test'. A future refactor that drops the env override trips
  // this immediately.
  it('T-ASG5 L5: does NOT contaminate the live ~/.opensquid/.current-session', async () => {
    const livePath = join(homedir(), '.opensquid', '.current-session');
    const before = existsSync(livePath) ? await readFile(livePath, 'utf8') : null;

    const upsPath = resolve(DIST_HOOKS, 'user-prompt-submit.js');
    expect(existsSync(upsPath), `compiled bin missing: ${upsPath}`).toBe(true);
    await runBin(upsPath, JSON.stringify({ prompt: 'hello', session_id: 'test' }));

    const after = existsSync(livePath) ? await readFile(livePath, 'utf8') : null;
    expect(after).toBe(before);
  }, 20_000);

  // T-HANDOFF-HARDENING HH6.1 L3 — session-start short-circuits on
  // clear/compact (mid-session sources): exit 0 and NO dispatch marker
  // (it returns before loadActivePacks/dispatchEvent).
  for (const source of ['compact', 'clear'] as const) {
    it(`session-start.js skips dispatch on source=${source} (exit 0, no marker)`, async () => {
      const binPath = resolve(DIST_HOOKS, 'session-start.js');
      expect(existsSync(binPath), `compiled bin missing: ${binPath}`).toBe(true);
      const r = await runBin(binPath, JSON.stringify({ session_id: 'test', source }));
      expect(r.exitCode, `stderr: ${r.stderr}`).toBe(0);
      expect(r.stderr).not.toContain('[opensquid-dispatch]');
    }, 20_000);
  }
});

async function runBin(
  binPath: string,
  stdin: string,
): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((res, rej) => {
    // Spawn with TRACE forced on (default-on; belt + braces in case CI env
    // sets OPENSQUID_DISPATCH_TRACE=0 for some other test's cleanup).
    const env = { ...process.env, OPENSQUID_DISPATCH_TRACE: '1' };
    // T-AUTO-HANDOFF: hooks act on their CWD (SessionEnd backup writer) —
    // spawn from the OS tmpdir so artifacts never land in the repo checkout.
    const p = spawn('node', [binPath], { stdio: ['pipe', 'pipe', 'pipe'], env, cwd: tmpdir() });
    let stderr = '';
    p.stderr.on('data', (b: Buffer) => (stderr += b.toString('utf8')));
    p.on('error', rej);
    p.on('close', (code) => res({ exitCode: code ?? -1, stderr }));
    p.stdin.write(stdin);
    p.stdin.end();
  });
}

/** Rebuilds `dist/` via tsc when any src/runtime/hooks/*.ts is newer than its
 * compiled .js, OR when the compiled bin is missing entirely. Gated by a
 * spawnSync timeout so a failing build can't hang `beforeAll`. */
function ensureFreshDist(): void {
  // Check the central dispatch.js — every hook bin depends on it, so if it's
  // stale ALL bins are stale. Also covers the "dist deleted" case.
  const distDispatch = resolve(DIST_HOOKS, 'dispatch.js');
  const srcDispatch = resolve(SRC_HOOKS, 'dispatch.ts');
  let needsBuild = false;
  if (!existsSync(distDispatch)) {
    needsBuild = true;
  } else {
    try {
      const distMtime = statSync(distDispatch).mtimeMs;
      const srcMtime = statSync(srcDispatch).mtimeMs;
      if (srcMtime > distMtime) needsBuild = true;
    } catch {
      needsBuild = true;
    }
  }
  // Also check each per-bin source.
  if (!needsBuild) {
    for (const spec of BIN_SPECS) {
      const srcFile = resolve(SRC_HOOKS, spec.bin.replace(/\.js$/, '.ts'));
      const distFile = resolve(DIST_HOOKS, spec.bin);
      if (!existsSync(distFile)) {
        needsBuild = true;
        break;
      }
      try {
        if (statSync(srcFile).mtimeMs > statSync(distFile).mtimeMs) {
          needsBuild = true;
          break;
        }
      } catch {
        needsBuild = true;
        break;
      }
    }
  }
  if (!needsBuild) return;

  // Rebuild. `tsc -p tsconfig.build.json` is the same command `pnpm build`
  // runs. Use spawnSync with a generous timeout — the typical build is ~3s
  // but cold-cache + slow CI runners can push to ~30s. 60s ceiling.
  const r = spawnSync('node', ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'], {
    cwd: REPO_ROOT,
    stdio: 'pipe',
    timeout: 60_000,
    encoding: 'utf-8',
  });
  if (r.error) {
    throw new Error(`hooks.bin.integration.test: tsc rebuild failed to launch: ${String(r.error)}`);
  }
  if (r.status !== 0) {
    throw new Error(
      `hooks.bin.integration.test: tsc rebuild exited ${String(r.status)}; stdout=${r.stdout ?? ''}; stderr=${r.stderr ?? ''}`,
    );
  }
}
