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
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '../../..');
const TSX_BIN = resolve(REPO_ROOT, 'node_modules/.bin/tsx');

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runHook(hookFile: string, stdin: string): Promise<RunResult> {
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
