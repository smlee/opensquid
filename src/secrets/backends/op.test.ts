/**
 * Tests for the op:// 1Password CLI subprocess backend.
 *
 * Fake-CLI approach (same as src/functions/llm.test.ts): write a tiny node
 * script to a per-test temp dir. Point `opBackend({ binary: process.execPath })`
 * at it via `args` — except we can't pass args through SecretBackend's API, so
 * we instead write a wrapper that ignores its args and reads behavior from
 * env vars FAKE_OUTPUT, FAKE_EXIT, FAKE_SLEEP_MS.
 *
 * The wrapper IS the binary — we point `binary` at a `process.execPath`
 * shim script via a small launcher .mjs that re-execs node with the script
 * path. Concretely: we set `opts.binary` to `process.execPath` and… that
 * doesn't quite work because `runOp` builds args itself (`['whoami']`, etc).
 *
 * Workaround: we DON'T use process.execPath as the binary. Instead we write
 * a shell script (.sh) on POSIX or a .cmd on win32 that re-execs `node`
 * with a node script path and forwards env. To stay cross-platform with
 * minimal effort, we set the binary path to a generated wrapper that on
 * darwin/linux is a shebang-line shell script and on win32 is a .cmd file.
 *
 * Even simpler — since this repo's CI is unix-only (matching dotenv.test.ts
 * pattern), and the existing llm.test.ts uses chmod-free .js + execPath,
 * we go: write a .js node script that ignores its argv, reads FAKE_*
 * env vars, prints + exits. Make the binary path itself a tiny shell
 * shim (`#!/usr/bin/env node\n//...`) and chmod 0o755. Node will then
 * invoke it directly as if it were the `op` CLI.
 *
 * This file does that.
 */

import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { opBackend } from './op.js';

// ---------------------------------------------------------------------------
// Per-test temp dir + env sandbox.
// ---------------------------------------------------------------------------

let tmpRoot: string;
const priorEnv: Record<string, string | undefined> = {};
const TRACKED_ENV_KEYS = ['FAKE_OUTPUT', 'FAKE_EXIT', 'FAKE_SLEEP_MS', 'FAKE_STDERR'];

beforeEach(async () => {
  for (const k of TRACKED_ENV_KEYS) {
    priorEnv[k] = process.env[k];
    delete process.env[k];
  }
  tmpRoot = await mkdtemp(join(tmpdir(), 'opensquid-op-test-'));
});

afterEach(async () => {
  for (const k of TRACKED_ENV_KEYS) {
    if (priorEnv[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = priorEnv[k];
    }
  }
  await rm(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// writeFakeOp: emit a shebang'd node script that consults FAKE_OUTPUT / FAKE_EXIT
// / FAKE_SLEEP_MS / FAKE_STDERR from process.env, then exits. Returns the
// absolute path. Sets the executable bit so child_process.spawn can launch
// it directly without specifying an interpreter.
//
// The script ignores argv entirely — the production `op` CLI has different
// argv shapes for `whoami` vs `read op://...`, but this stub treats every
// invocation the same. That's intentional: behavior is configured by env vars
// the test sets just before invoking the backend.
// ---------------------------------------------------------------------------

async function writeFakeOp(): Promise<string> {
  const script = `#!${process.execPath}
const output = process.env.FAKE_OUTPUT ?? '';
const exitCode = Number(process.env.FAKE_EXIT ?? '0');
const sleepMs = Number(process.env.FAKE_SLEEP_MS ?? '0');
const stderrOutput = process.env.FAKE_STDERR ?? '';
function done() {
  if (output) process.stdout.write(output);
  if (stderrOutput) process.stderr.write(stderrOutput);
  process.exit(exitCode);
}
if (sleepMs > 0) {
  setTimeout(done, sleepMs);
} else {
  done();
}
`;
  const path = join(tmpRoot, `fake-op-${Math.random().toString(36).slice(2, 8)}`);
  await writeFile(path, script, 'utf8');
  await chmod(path, 0o755);
  return path;
}

// ---------------------------------------------------------------------------
// 1. resolve() happy path: fake binary prints 'secret-value' on stdout, exit 0
//    → returns 'secret-value' (trimmed).
// ---------------------------------------------------------------------------

describe('opBackend.resolve', () => {
  it('returns trimmed stdout when fake op exits 0', async () => {
    const bin = await writeFakeOp();
    process.env.FAKE_OUTPUT = 'secret-value\n';
    process.env.FAKE_EXIT = '0';
    const backend = opBackend({ binary: bin });
    const got = await backend.resolve('vault/item/field');
    expect(got).toBe('secret-value');
  });

  // -------------------------------------------------------------------------
  // 2. resolve() with non-zero exit → null.
  // -------------------------------------------------------------------------
  it('returns null when fake op exits non-zero', async () => {
    const bin = await writeFakeOp();
    process.env.FAKE_OUTPUT = 'should-be-ignored';
    process.env.FAKE_EXIT = '1';
    process.env.FAKE_STDERR = '[ERROR] item not found';
    const backend = opBackend({ binary: bin });
    const got = await backend.resolve('vault/missing/field');
    expect(got).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 3. resolve() with binary missing (spawn-error path) → null.
  // -------------------------------------------------------------------------
  it('returns null when binary is missing (spawn-error path)', async () => {
    const backend = opBackend({ binary: '/nonexistent/path/to/op-binary-xyz' });
    const got = await backend.resolve('vault/item/field');
    expect(got).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. validate() happy path: fake binary exits 0 → { ok: true }.
// ---------------------------------------------------------------------------

describe('opBackend.validate', () => {
  it('returns { ok: true } when fake op whoami exits 0', async () => {
    const bin = await writeFakeOp();
    process.env.FAKE_OUTPUT = 'user@example.com';
    process.env.FAKE_EXIT = '0';
    const backend = opBackend({ binary: bin });
    expect(typeof backend.validate).toBe('function');
    const got = await backend.validate?.();
    expect(got).toEqual({ ok: true });
  });

  // -------------------------------------------------------------------------
  // 5. validate() with non-zero exit → { ok: false, error: stderr }.
  // -------------------------------------------------------------------------
  it('returns { ok: false, error: stderr } when fake op whoami exits non-zero', async () => {
    const bin = await writeFakeOp();
    process.env.FAKE_EXIT = '1';
    process.env.FAKE_STDERR = '[ERROR] not signed in';
    const backend = opBackend({ binary: bin });
    const got = await backend.validate?.();
    expect(got).toEqual({ ok: false, error: '[ERROR] not signed in' });
  });
});

// ---------------------------------------------------------------------------
// 6. Timeout: fake binary sleeps 2s, timeoutMs=200 → SIGTERM fires, returns
//    null, and the call returns in < 1000ms.
// ---------------------------------------------------------------------------

describe('opBackend.resolve timeout', () => {
  it('kills via SIGTERM and returns null within < 1000ms when binary hangs', async () => {
    const bin = await writeFakeOp();
    process.env.FAKE_OUTPUT = 'too-late';
    process.env.FAKE_EXIT = '0';
    process.env.FAKE_SLEEP_MS = '2000';
    const backend = opBackend({ binary: bin, timeoutMs: 200 });
    const t0 = Date.now();
    const got = await backend.resolve('vault/item/field');
    const elapsed = Date.now() - t0;
    expect(got).toBeNull();
    expect(elapsed).toBeLessThan(1000);
  });
});

// ---------------------------------------------------------------------------
// Sanity check: the fake-op script we generate is itself runnable. Catches
// CI environments where executable-bit semantics differ (e.g. mounted FS
// with noexec). If this fails, the rest of the suite is meaningless, so we
// surface it as its own test with a clear failure message.
// ---------------------------------------------------------------------------

describe('opBackend test-harness sanity', () => {
  it('fake op binary is directly executable', async () => {
    const bin = await writeFakeOp();
    const r = spawnSync(bin, ['whoami'], {
      env: { ...process.env, FAKE_OUTPUT: 'sanity', FAKE_EXIT: '0' },
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('sanity');
  });
});
