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
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
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

  it('session-end: valid payload → exit 0', async () => {
    const stdin = JSON.stringify({ sessionId: 'abc' });
    const r = await runHook('session-end.ts', stdin);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
  }, 15000);

  it('pre-tool-use: snake_case payload normalized to camelCase', async () => {
    const stdin = JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/tmp/x' } });
    const r = await runHook('pre-tool-use.ts', stdin);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
  }, 15000);
});

/**
 * ASC.1 — chain-state writer integration. Each test seeds a synthetic event
 * to the appropriate hook bin against the isolated tempHome and asserts the
 * persisted chain-state file picked up the transition.
 *
 * Path: `<tempHome>/sessions/<session-id>/state/chain-state.json` per
 * `sessionStateFile(<id>, 'chain-state')`.
 */
describe('hook subprocess integration — ASC.1 chain-state writers', () => {
  it('PreToolUse Write to docs/research/*-pre-research-*.md → chain.stage = "researched"', async () => {
    const sessionId = `asc1-research-${Date.now()}`;
    const stdin = JSON.stringify({
      tool: 'Write',
      args: {
        file_path: '/abs/repo/docs/research/T-foo-pre-research-2026-05-28.md',
        content: '# pre-research',
      },
      session_id: sessionId,
    });
    const r = await runHook('pre-tool-use.ts', stdin);
    expect(r.exitCode).toBe(0);
    const statePath = join(tempHome, 'sessions', sessionId, 'state', 'chain-state.json');
    const raw = await readFile(statePath, 'utf8');
    const state = JSON.parse(raw) as { stage: string; pre_research_path?: string };
    expect(state.stage).toBe('researched');
    expect(state.pre_research_path).toBe(
      '/abs/repo/docs/research/T-foo-pre-research-2026-05-28.md',
    );
  }, 15000);

  it('PreToolUse Write to docs/tasks/T-*.md → chain.stage = "spec_authored"', async () => {
    const sessionId = `asc1-spec-${Date.now()}`;
    const stdin = JSON.stringify({
      tool: 'Write',
      args: { file_path: '/abs/repo/docs/tasks/T-foo.md', content: '# spec' },
      session_id: sessionId,
    });
    const r = await runHook('pre-tool-use.ts', stdin);
    expect(r.exitCode).toBe(0);
    const statePath = join(tempHome, 'sessions', sessionId, 'state', 'chain-state.json');
    const state = JSON.parse(await readFile(statePath, 'utf8')) as {
      stage: string;
      spec_path?: string;
    };
    expect(state.stage).toBe('spec_authored');
    expect(state.spec_path).toBe('/abs/repo/docs/tasks/T-foo.md');
  }, 15000);

  it('PreToolUse TaskCreate with metadata.taskId → chain.stage = "tasks_loaded"', async () => {
    const sessionId = `asc1-tasks-${Date.now()}`;
    const stdin = JSON.stringify({
      tool: 'TaskCreate',
      args: { subject: 'do thing', metadata: { taskId: 'ASC.X' } },
      session_id: sessionId,
    });
    const r = await runHook('pre-tool-use.ts', stdin);
    expect(r.exitCode).toBe(0);
    const statePath = join(tempHome, 'sessions', sessionId, 'state', 'chain-state.json');
    const state = JSON.parse(await readFile(statePath, 'utf8')) as {
      stage: string;
      task_ids?: string[];
    };
    expect(state.stage).toBe('tasks_loaded');
    expect(state.task_ids).toEqual(['ASC.X']);
  }, 15000);

  it('PreToolUse TaskCreate WITHOUT metadata.taskId → no chain-state file (no transition)', async () => {
    const sessionId = `asc1-no-tasks-${Date.now()}`;
    const stdin = JSON.stringify({
      tool: 'TaskCreate',
      args: { subject: 'do thing' },
      session_id: sessionId,
    });
    await runHook('pre-tool-use.ts', stdin);
    const statePath = join(tempHome, 'sessions', sessionId, 'state', 'chain-state.json');
    const present = await stat(statePath).catch(() => null);
    expect(present).toBeNull();
  }, 15000);

  it('UserPromptSubmit with scope-intent on idle chain → chain.stage = "scoping"', async () => {
    const sessionId = `asc1-scoping-${Date.now()}`;
    const stdin = JSON.stringify({
      prompt: 'scope out a new track',
      session_id: sessionId,
    });
    const r = await runHook('user-prompt-submit.ts', stdin);
    expect(r.exitCode).toBe(0);
    const statePath = join(tempHome, 'sessions', sessionId, 'state', 'chain-state.json');
    const state = JSON.parse(await readFile(statePath, 'utf8')) as { stage: string };
    expect(state.stage).toBe('scoping');
  }, 15000);

  it('UserPromptSubmit without scope-intent on idle chain → no chain-state file', async () => {
    const sessionId = `asc1-no-scoping-${Date.now()}`;
    const stdin = JSON.stringify({
      prompt: 'hello world, just chatting',
      session_id: sessionId,
    });
    await runHook('user-prompt-submit.ts', stdin);
    const statePath = join(tempHome, 'sessions', sessionId, 'state', 'chain-state.json');
    const present = await stat(statePath).catch(() => null);
    expect(present).toBeNull();
  }, 15000);

  it('SessionEnd clears the chain-state file', async () => {
    const sessionId = `asc1-clear-${Date.now()}`;
    // Pre-seed: write a scoping transition via UserPromptSubmit.
    await runHook(
      'user-prompt-submit.ts',
      JSON.stringify({ prompt: 'plan out the next track', session_id: sessionId }),
    );
    const statePath = join(tempHome, 'sessions', sessionId, 'state', 'chain-state.json');
    expect(await stat(statePath).catch(() => null)).not.toBeNull();
    // SessionEnd should clear it.
    await runHook('session-end.ts', JSON.stringify({ sessionId, session_id: sessionId }));
    expect(await stat(statePath).catch(() => null)).toBeNull();
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
