/**
 * Tests for the keychain: cross-platform OS keychain backend.
 *
 * Test approach: FAKE BINARY (same as op.test.ts).
 *
 * Real OS-keychain integration is intentionally NOT exercised here, because:
 *   - macOS `security` may pop a user-consent dialog on first access, blocking
 *     CI and being noisy on dev machines.
 *   - Linux `secret-tool` requires a running DBUS session bus, which CI
 *     containers typically lack.
 *   - Windows `cmdkey` doesn't expose passwords at all (security feature).
 *
 * Instead, each test points `binaries.<platform>` at a generated shebang'd
 * node script that ignores its argv and prints `FAKE_OUTPUT` to stdout with
 * exit code `FAKE_EXIT`. This isolates:
 *   - argv shape (each platform's lookup helper builds its own argv)
 *   - exit-code handling (0 → stdout trim → value; non-0 → null)
 *   - spawn-error path (binary missing → null without throwing)
 *   - SIGTERM timeout
 *
 * One additional darwin-only test (`it.skipIf(process.platform !== 'darwin')`)
 * uses the real `security` binary against a guaranteed-missing entry to
 * confirm the dispatch path resolves to null on the dev box without consent
 * prompts.
 */

import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { keychainBackend } from './keychain.js';

// ---------------------------------------------------------------------------
// Per-test temp dir + env sandbox.
// ---------------------------------------------------------------------------

let tmpRoot: string;
const priorEnv: Record<string, string | undefined> = {};
const TRACKED_ENV_KEYS = ['FAKE_OUTPUT', 'FAKE_EXIT', 'FAKE_SLEEP_MS', 'FAKE_ARGV_LOG'];

beforeEach(async () => {
  for (const k of TRACKED_ENV_KEYS) {
    priorEnv[k] = process.env[k];
    delete process.env[k];
  }
  tmpRoot = await mkdtemp(join(tmpdir(), 'opensquid-keychain-test-'));
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
// writeFakeBin: emit a shebang'd node script. The script:
//   - logs argv (minus argv[0]+argv[1]) to FAKE_ARGV_LOG if set
//   - prints FAKE_OUTPUT to stdout
//   - exits with FAKE_EXIT (default 0)
//   - sleeps FAKE_SLEEP_MS before exiting (for timeout tests)
// Sets executable bit so child_process.spawn can launch it directly.
// ---------------------------------------------------------------------------

async function writeFakeBin(): Promise<string> {
  const script = `#!${process.execPath}
const fs = require('node:fs');
const output = process.env.FAKE_OUTPUT ?? '';
const exitCode = Number(process.env.FAKE_EXIT ?? '0');
const sleepMs = Number(process.env.FAKE_SLEEP_MS ?? '0');
const argvLog = process.env.FAKE_ARGV_LOG;
if (argvLog) {
  // argv[0] = node binary, argv[1] = this script path; remaining = real args.
  fs.writeFileSync(argvLog, JSON.stringify(process.argv.slice(2)));
}
function done() {
  if (output) process.stdout.write(output);
  process.exit(exitCode);
}
if (sleepMs > 0) {
  setTimeout(done, sleepMs);
} else {
  done();
}
`;
  const path = join(tmpRoot, `fake-bin-${Math.random().toString(36).slice(2, 8)}`);
  await writeFile(path, script, 'utf8');
  await chmod(path, 0o755);
  return path;
}

// ---------------------------------------------------------------------------
// Helper: tag tests as "active on current platform" or "cross-platform argv-
// shape" — both kinds run regardless of host platform, because the fake-bin
// shim doesn't care about the host. The actual platform-dispatch test below
// uses `process.platform` directly and asserts argv shape per-host.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 1. resolve() happy path (current platform): fake bin prints 'secret-value',
//    exits 0 → returns 'secret-value' (trimmed of trailing newline).
//
//    We point the per-platform override at the fake bin, so this works on any
//    host platform — the production dispatcher picks the right key from the
//    binaries map based on process.platform.
// ---------------------------------------------------------------------------

describe('keychainBackend.resolve', () => {
  it('returns trimmed stdout when current-platform binary exits 0', async () => {
    const bin = await writeFakeBin();
    process.env.FAKE_OUTPUT = 'secret-value\n';
    process.env.FAKE_EXIT = '0';
    const backend = keychainBackend({
      service: 'opensquid',
      binaries: { darwin: bin, linux: bin, win32: bin },
    });
    const got = await backend.resolve('TEST_KEY');
    expect(got).toBe('secret-value');
  });

  // -------------------------------------------------------------------------
  // 2. Missing entry → null (non-zero exit).
  // -------------------------------------------------------------------------
  it('returns null when current-platform binary exits non-zero (not found)', async () => {
    const bin = await writeFakeBin();
    process.env.FAKE_OUTPUT = '';
    process.env.FAKE_EXIT = '44'; // mimic `security` not-found exit code
    const backend = keychainBackend({
      binaries: { darwin: bin, linux: bin, win32: bin },
    });
    const got = await backend.resolve('NO_SUCH_KEY');
    // win32 path's existence-check returns '' on exit 0 — but exit 44 means
    // not-found on every platform → null.
    expect(got).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 3. Spawn-error path (binary missing on PATH) → null, no throw.
  // -------------------------------------------------------------------------
  it('returns null when current-platform binary is missing (spawn-error)', async () => {
    const missing = '/nonexistent/path/to/keychain-binary-xyz';
    const backend = keychainBackend({
      binaries: { darwin: missing, linux: missing, win32: missing },
    });
    const got = await backend.resolve('TEST_KEY');
    expect(got).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 4. service/account ref parsing: 'myservice/myacc' → service=myservice,
  //    account=myacc. Verified by argv-log capture.
  //
  //    Each platform has a different argv shape, so we assert the platform-
  //    specific shape that matches `process.platform`.
  // -------------------------------------------------------------------------
  it('parses service/account ref form and passes both to the platform binary', async () => {
    const bin = await writeFakeBin();
    const argvLog = join(tmpRoot, 'argv.json');
    process.env.FAKE_ARGV_LOG = argvLog;
    process.env.FAKE_OUTPUT = 'val';
    process.env.FAKE_EXIT = '0';
    const backend = keychainBackend({
      binaries: { darwin: bin, linux: bin, win32: bin },
    });
    await backend.resolve('myservice/myacc');
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(argvLog, 'utf8');
    const argv = JSON.parse(raw) as string[];

    if (process.platform === 'darwin') {
      // ['find-generic-password', '-s', 'myservice', '-a', 'myacc', '-w']
      expect(argv).toEqual(['find-generic-password', '-s', 'myservice', '-a', 'myacc', '-w']);
    } else if (process.platform === 'linux') {
      // ['lookup', 'service', 'myservice', 'account', 'myacc']
      expect(argv).toEqual(['lookup', 'service', 'myservice', 'account', 'myacc']);
    } else if (process.platform === 'win32') {
      // ['/list:myservice:myacc']
      expect(argv).toEqual(['/list:myservice:myacc']);
    } else {
      // Unsupported platform → resolve returns null and the bin is never
      // invoked. We don't assert here; just confirm no argv was logged.
      const stat = await import('node:fs/promises').then((m) => m.stat(argvLog).catch(() => null));
      expect(stat).toBeNull();
    }
  });

  // -------------------------------------------------------------------------
  // 5. Default service applied when ref has no '/'. argv-log inspection.
  // -------------------------------------------------------------------------
  it('uses default service when ref has no slash', async () => {
    const bin = await writeFakeBin();
    const argvLog = join(tmpRoot, 'argv-default.json');
    process.env.FAKE_ARGV_LOG = argvLog;
    process.env.FAKE_OUTPUT = 'val';
    process.env.FAKE_EXIT = '0';
    const backend = keychainBackend({
      service: 'opensquid',
      binaries: { darwin: bin, linux: bin, win32: bin },
    });
    await backend.resolve('JUST_AN_ACCOUNT');
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(argvLog, 'utf8');
    const argv = JSON.parse(raw) as string[];

    if (process.platform === 'darwin') {
      expect(argv).toContain('-s');
      expect(argv).toContain('opensquid');
      expect(argv).toContain('-a');
      expect(argv).toContain('JUST_AN_ACCOUNT');
    } else if (process.platform === 'linux') {
      expect(argv).toEqual(['lookup', 'service', 'opensquid', 'account', 'JUST_AN_ACCOUNT']);
    } else if (process.platform === 'win32') {
      expect(argv).toEqual(['/list:opensquid:JUST_AN_ACCOUNT']);
    }
  });

  // -------------------------------------------------------------------------
  // 6. Timeout: fake bin sleeps 2s, timeoutMs=200 → SIGTERM fires, returns
  //    null, call completes in < 1000ms.
  // -------------------------------------------------------------------------
  it('kills via SIGTERM and returns null within < 1000ms when binary hangs', async () => {
    const bin = await writeFakeBin();
    process.env.FAKE_OUTPUT = 'too-late';
    process.env.FAKE_EXIT = '0';
    process.env.FAKE_SLEEP_MS = '2000';
    const backend = keychainBackend({
      binaries: { darwin: bin, linux: bin, win32: bin },
      timeoutMs: 200,
    });
    const t0 = Date.now();
    const got = await backend.resolve('TEST_KEY');
    const elapsed = Date.now() - t0;
    expect(got).toBeNull();
    expect(elapsed).toBeLessThan(1000);
  });
});

// ---------------------------------------------------------------------------
// 7. Darwin-only smoke test against the REAL `security` binary, looking up an
// entry guaranteed not to exist (random suffix). Confirms the production
// dispatch path reaches `security` without consent prompts and resolves to
// null cleanly.
//
// Skipped on non-darwin hosts via it.skipIf.
// ---------------------------------------------------------------------------

describe('keychainBackend.resolve (real darwin security binary, missing entry)', () => {
  it.skipIf(process.platform !== 'darwin')(
    'returns null for a guaranteed-missing keychain entry without prompting',
    async () => {
      const backend = keychainBackend({ service: 'opensquid-test-nonexistent' });
      const ref = `NO_SUCH_KEY_${Math.random().toString(36).slice(2, 10)}`;
      const got = await backend.resolve(ref);
      expect(got).toBeNull();
    },
  );
});

// ---------------------------------------------------------------------------
// 8. Sanity check: fake bin itself is directly executable (same pattern as
// op.test.ts; catches CI environments where exec-bit semantics differ).
// ---------------------------------------------------------------------------

describe('keychainBackend test-harness sanity', () => {
  it('fake binary is directly executable', async () => {
    const bin = await writeFakeBin();
    const r = spawnSync(bin, ['anything'], {
      env: { ...process.env, FAKE_OUTPUT: 'sanity', FAKE_EXIT: '0' },
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('sanity');
  });
});
