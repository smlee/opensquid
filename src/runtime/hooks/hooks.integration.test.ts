/**
 * Subprocess integration test: spawn each hook binary, feed stdin, assert
 * exit-code + stderr.
 *
 * Why tsx (not the compiled `dist/`): the test runs against TS sources via
 * the `tsx` ESM loader (already installed as a transitive vitest dep). This
 * is ~10× faster than building `dist/` and avoids coupling test order to a
 * preceding `pnpm build`. The downside is that the test exercises tsx's
 * loader rather than plain Node's — but every hook binary still goes through
 * the real ESM resolution + `process.stdin` async iterator path, which is
 * what we actually need to verify.
 *
 * Cases:
 *   1. pre-tool-use with valid JSON + empty packs → exit 0, empty stderr.
 *   2. pre-tool-use with malformed JSON → exit 0 (fail-open), stderr mentions
 *      'invalid'.
 *   3. pre-tool-use with empty stdin → exit 0, informative stderr.
 *   4. stop hook with valid payload → exit 0 (no packs active in stub).
 *   5. user-prompt-submit + session-end smoke (basic shape).
 *
 * NOTE: Task 1.7's `loadActivePacks` is a stub that returns []. The "pack
 * injection blocks tool call" case is deferred to Task 1.19's smoke test
 * (where the real loader exists). All cases here exercise the stub's
 * pass-through behavior; the dispatcher itself is unit-tested separately
 * in `dispatch.test.ts`.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '../../..');
const TSX_BIN = resolve(REPO_ROOT, 'node_modules/.bin/tsx');

// ASG.1: isolate OPENSQUID_HOME so the spawned hook bins write session state
// into a tmp dir, not the dev's real ~/.opensquid/. Without this, every
// `pnpm test` run scribbled sessions/test-session/state/tool-ledger.json +
// overwrote .current-session = 'test-session' in the real home — silently
// breaking downstream `opensquid automation` CLI invocations (the CLI's
// .current-session fallback would write the flag to the wrong session id).
// Mirrors session_id.test.ts:25-43 (the proven isolation pattern in this repo).
let tempHome: string;
let priorHome: string | undefined;
const REAL_HOME_OPENSQUID = join(homedir(), '.opensquid');

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

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runHook(
  hookFile: string,
  stdin: string,
  envOverride: Record<string, string> = {},
): Promise<RunResult> {
  const hookPath = resolve(__dirname, hookFile);
  return new Promise<RunResult>((resolvePromise, reject) => {
    const proc = spawn(TSX_BIN, [hookPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // T-AUTO-HANDOFF: hooks act on their CWD (the SessionEnd backup writer
      // resolves the umbrella root from it) — spawn from the OS tmpdir so a
      // hook can never write artifacts into the repo checkout.
      cwd: tmpdir(),
      // G.2: silence the dispatch-trace marker so the legacy "empty stderr
      // on allow" assertions here keep their contract. The marker is
      // diagnostic; its presence is asserted in `hooks.bin.integration.test.ts`
      // (the dedicated regression net against silent-no-op).
      env: {
        ...process.env,
        CLAUDE_SESSION_ID: 'test-session',
        OPENSQUID_DISPATCH_TRACE: '0',
        ...envOverride,
      },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (b: Buffer) => (stdout += b.toString('utf8')));
    proc.stderr.on('data', (b: Buffer) => (stderr += b.toString('utf8')));
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => resolvePromise({ exitCode: code ?? -1, stdout, stderr }));
    proc.stdin.write(stdin);
    proc.stdin.end();
  });
}

describe('hook subprocess integration', () => {
  it('pre-tool-use: valid JSON + no active packs → exit 0, empty stderr', async () => {
    const stdin = JSON.stringify({ tool: 'Bash', args: { command: 'git status' } });
    const r = await runHook('pre-tool-use.ts', stdin);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
  }, 15000);

  it('pre-tool-use: malformed JSON → exit 0 (fail-open), stderr mentions invalid', async () => {
    const r = await runHook('pre-tool-use.ts', '{not valid json');
    expect(r.exitCode).toBe(0);
    expect(r.stderr.toLowerCase()).toContain('invalid');
  }, 15000);

  it('pre-tool-use: empty stdin → exit 0, informative stderr', async () => {
    const r = await runHook('pre-tool-use.ts', '');
    expect(r.exitCode).toBe(0);
    expect(r.stderr.toLowerCase()).toContain('empty');
  }, 15000);

  it('pre-tool-use: the Safety FLOOR denies a forbidden Bash action before execution (T2)', async () => {
    const stdin = JSON.stringify({
      tool: 'Bash',
      args: { command: 'rm -rf / --no-preserve-root' },
    });
    const r = await runHook('pre-tool-use.ts', stdin);
    expect(r.exitCode).toBe(0); // the deny rides the JSON envelope (exit 0), not a bare exit 2
    expect(r.stdout).toContain('deny');
    expect(r.stdout.toLowerCase()).toContain('safety floor');
  }, 15000);

  it('pre-tool-use: the Safety floor is TOOL-SCOPED — a Write that merely mentions a pattern is allowed', async () => {
    // action ≠ content: writing a file whose text contains the dangerous pattern is NOT a Bash execution.
    const stdin = JSON.stringify({
      tool: 'Write',
      args: { file_path: '/tmp/notes.txt', content: 'reminder: never run rm -rf / on prod' },
    });
    const r = await runHook('pre-tool-use.ts', stdin);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toLowerCase()).not.toContain('safety floor'); // not denied — content, not action
  }, 15000);

  it('stop: valid payload → exit 0 (no packs active)', async () => {
    const stdin = JSON.stringify({ assistantText: 'task done' });
    const r = await runHook('stop.ts', stdin);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
  }, 15000);

  it('user-prompt-submit: valid payload → exit 0', async () => {
    const stdin = JSON.stringify({ prompt: 'hello' });
    const r = await runHook('user-prompt-submit.ts', stdin);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
  }, 15000);

  it('session-end: bare session (no FSM, no task) → handoff SKIPPED by the substance gate', async () => {
    const stdin = JSON.stringify({ sessionId: 'bare-gate-test' });
    const r = await runHook('session-end.ts', stdin);
    expect(r.exitCode).toBe(0);
    // AHO.3: trivial sessions must produce NO surfaces — just the skip note.
    expect(r.stderr).toContain('auto-handoff skipped — no resumable state');
    expect(r.stderr).not.toContain('auto-handoff written');
  }, 15000);

  it('pre-tool-use: snake_case payload normalized to camelCase', async () => {
    const stdin = JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/tmp/x' } });
    const r = await runHook('pre-tool-use.ts', stdin);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
  }, 15000);
});

/**
 * ASG.1 regression net. The previous bug had hooks.integration.test.ts using
 * `CLAUDE_SESSION_ID=test-session` with NO `OPENSQUID_HOME` isolation, so the
 * hook bins wrote `sessions/<id>/state/tool-ledger.json` into the dev's REAL
 * `~/.opensquid/`.
 *
 * Targets `state/tool-ledger.json` (NOT `automation.flag`) because that's the
 * file `pre-tool-use`'s `appendTool` path actually writes — verified at
 * `pre-tool-use.ts:83-88` + `session_state.ts` `appendTool` → `sessionLogFile(...,
 * 'tool-ledger')`. `automation.flag` is only written by the `opensquid
 * automation on` CLI, never by a hook, so asserting on it would be toothless.
 *
 * Uses a per-test uuid-shaped session id so the assertion can't false-positive
 * on pre-existing state under a shared name. With isolation present (the
 * beforeEach above), the hook writes to `tempHome` — nothing under the real
 * home's `sessions/<probeSessionId>/` ever materializes. Removing the
 * `OPENSQUID_HOME = tempHome` line in beforeEach causes this test to FAIL —
 * the regression has teeth.
 */
describe('hook subprocess integration — does not contaminate real ~/.opensquid', () => {
  it('writes nothing under real ~/.opensquid/sessions/<probe-id>/state/ on a hook invocation', async () => {
    const probeSessionId = `asg1-probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const probedFile = join(
      REAL_HOME_OPENSQUID,
      'sessions',
      probeSessionId,
      'state',
      'tool-ledger.json',
    );

    const stdin = JSON.stringify({
      tool: 'Bash',
      args: { command: 'git status' },
      session_id: probeSessionId,
    });
    await runHook('pre-tool-use.ts', stdin);

    const realHomeWrite = await stat(probedFile).catch(() => null);
    expect(realHomeWrite).toBeNull();
  }, 15000);
});
