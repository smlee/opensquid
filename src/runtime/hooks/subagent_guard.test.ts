/**
 * SUB.1 (T-handoff-nested-session-spam, wg-627effbb2c38) — the subagent
 * hook-pipeline short-circuit.
 *
 * Unit: `isOpensquidSubagent` is an exact-'1' env predicate.
 * Integration (tsx source-spawn, same pattern as hooks.integration.test.ts):
 * a hook bin run with OPENSQUID_SUBAGENT=1 exits 0, says "skipped", and
 * mints ZERO session state under an isolated OPENSQUID_HOME; the same bin
 * WITHOUT the marker keeps today's behavior (tool-ledger appears) — the
 * regression pin that the guard changes nothing for real sessions.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isOpensquidSubagent } from './subagent_guard.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');
const TSX_BIN = resolve(REPO_ROOT, 'node_modules/.bin/tsx');

describe('isOpensquidSubagent', () => {
  it('true only on the exact string "1"', () => {
    expect(isOpensquidSubagent({ OPENSQUID_SUBAGENT: '1' })).toBe(true);
    expect(isOpensquidSubagent({})).toBe(false);
    expect(isOpensquidSubagent({ OPENSQUID_SUBAGENT: '0' })).toBe(false);
    expect(isOpensquidSubagent({ OPENSQUID_SUBAGENT: 'true' })).toBe(false);
    expect(isOpensquidSubagent({ OPENSQUID_SUBAGENT: '' })).toBe(false);
  });
});

interface RunResult {
  code: number | null;
  stderr: string;
}

function runHookBin(env: Record<string, string>, stdin: string): Promise<RunResult> {
  const hookPath = resolve(__dirname, 'pre-tool-use.ts');
  return new Promise<RunResult>((resolvePromise, reject) => {
    const proc = spawn(TSX_BIN, [hookPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: tmpdir(),
      env: { ...process.env, OPENSQUID_DISPATCH_TRACE: '0', ...env },
    });
    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    proc.on('error', reject);
    proc.on('close', (code) => resolvePromise({ code, stderr }));
    proc.stdin.write(stdin);
    proc.stdin.end();
  });
}

describe('hook bin short-circuit (tsx source spawn)', () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'opensquid-subguard-'));
  });

  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true });
  });

  const payload = JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command: 'echo hi' },
    session_id: 'subguard-test-session',
  });

  it('marked: exit 0, "skipped" on stderr, ZERO session state minted', async () => {
    const res = await runHookBin({ OPENSQUID_HOME: tempHome, OPENSQUID_SUBAGENT: '1' }, payload);
    expect(res.code).toBe(0);
    expect(res.stderr).toContain('skipped (OPENSQUID_SUBAGENT)');
    // The whole point: no sessions/<sid>/ tree appears at all.
    expect(existsSync(join(tempHome, 'sessions'))).toBe(false);
  }, 30_000);

  it('unmarked: behavior unchanged — the tool ledger appears (regression pin)', async () => {
    const res = await runHookBin({ OPENSQUID_HOME: tempHome }, payload);
    expect(res.code).toBe(0);
    const stateDir = join(tempHome, 'sessions', 'subguard-test-session', 'state');
    const entries = existsSync(stateDir) ? await readdir(stateDir) : [];
    expect(entries).toContain('tool-ledger.json');
  }, 30_000);
});
