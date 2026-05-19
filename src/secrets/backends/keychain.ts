/**
 * Cross-platform OS keychain backend for the secrets resolver.
 *
 * Per-platform dispatch via `process.platform`:
 *   - darwin → `security find-generic-password -s <svc> -a <acc> -w` (stdout = pw)
 *   - linux  → `secret-tool lookup service <svc> account <acc>`     (stdout = pw)
 *   - win32  → `cmdkey /list:<svc>:<acc>` (Phase 1 illustrative existence-check;
 *              real value retrieval requires the Windows Credential Manager API
 *              and is deferred to a later phase — see UI.7 hand-off note in
 *              task 1.17 risk-callouts).
 *   - other  → null (unsupported platform).
 *
 * The dispatch is STRICT: macOS code paths never run on Linux, and vice versa.
 * No env-var-driven cross-platform shimming.
 *
 * Reference shape:
 *   - `<account>`              → uses default service (configured via opts.service)
 *   - `<service>/<account>`    → overrides service for this lookup
 *
 * Subprocess discipline (matches op.ts):
 *   - `stdio: ['ignore', 'pipe', 'pipe']` — no stdin needed.
 *   - SIGTERM after `timeoutMs` (default 5000) to bound interactive consent
 *     prompts (macOS Keychain may pop a system dialog on first access).
 *   - Spawn errors (binary missing) and non-zero exits BOTH return null at the
 *     public API. Internally the helper still distinguishes the two so future
 *     telemetry can surface "backend missing" vs "not found" separately.
 *
 * Security:
 *   - NEVER log resolved secret values. This module logs nothing.
 *
 * macOS gotcha (post-research note, UI.7 hand-off): on first access to a
 * keychain item, macOS may prompt the user to allow access. The 5s timeout
 * catches a blocked prompt, but the setup UI should warn users.
 *
 * Imports from: node:child_process, ../types.js.
 * Imported by: src/secrets/index.ts.
 */

import { spawn } from 'node:child_process';

import type { SecretBackend } from '../types.js';

export interface KeychainBackendOptions {
  /** Default service name used when a ref has no `<service>/` prefix. Default 'opensquid'. */
  service?: string;
  /** Subprocess timeout in ms. Default 5000. */
  timeoutMs?: number;
  /**
   * Optional per-platform binary overrides. Used by tests to inject fake CLIs
   * that mimic the real binaries' argv shape without depending on a real
   * Keychain / libsecret / Credential Manager being present.
   *
   * Production code paths leave these undefined, so the real `security`,
   * `secret-tool`, and `cmdkey` are invoked via PATH lookup.
   */
  binaries?: {
    darwin?: string;
    linux?: string;
    win32?: string;
  };
}

interface RunResult {
  /** Process exit code, or -1 if spawn itself failed (binary missing). */
  code: number;
  stdout: string;
}

export function keychainBackend(opts: KeychainBackendOptions = {}): SecretBackend {
  const service = opts.service ?? 'opensquid';
  const timeout = opts.timeoutMs ?? 5000;
  const binaries = opts.binaries ?? {};

  return {
    scheme: 'keychain',
    async resolve(ref: string): Promise<string | null> {
      const [svc, acc] = parseRef(ref, service);
      switch (process.platform) {
        case 'darwin':
          return macosLookup(binaries.darwin ?? 'security', svc, acc, timeout);
        case 'linux':
          return linuxLookup(binaries.linux ?? 'secret-tool', svc, acc, timeout);
        case 'win32':
          return windowsLookup(binaries.win32 ?? 'cmdkey', svc, acc, timeout);
        default:
          return null;
      }
    },
  };
}

/**
 * Parse a backend-scoped reference into `[service, account]`.
 *
 * `acc` (no slash)          → [defaultService, acc]
 * `svc/acc`                 → [svc, acc]
 * `svc/with/slashes/in/acc` → [svc, 'with/slashes/in/acc']  (first `/` is the split)
 *
 * Empty string is treated as account = '' under default service; the platform
 * lookup will then fail to find it and return null — no special-case here.
 */
function parseRef(ref: string, defaultService: string): [string, string] {
  const slash = ref.indexOf('/');
  if (slash < 0) return [defaultService, ref];
  return [ref.slice(0, slash), ref.slice(slash + 1)];
}

async function macosLookup(
  bin: string,
  service: string,
  account: string,
  timeoutMs: number,
): Promise<string | null> {
  const r = await runCapture(
    bin,
    ['find-generic-password', '-s', service, '-a', account, '-w'],
    timeoutMs,
  );
  return r.code === 0 ? r.stdout.trim() : null;
}

async function linuxLookup(
  bin: string,
  service: string,
  account: string,
  timeoutMs: number,
): Promise<string | null> {
  const r = await runCapture(bin, ['lookup', 'service', service, 'account', account], timeoutMs);
  return r.code === 0 ? r.stdout.trim() : null;
}

async function windowsLookup(
  bin: string,
  service: string,
  account: string,
  timeoutMs: number,
): Promise<string | null> {
  // Phase 1 illustrative: `cmdkey /list:<target>` exits 0 if the credential
  // exists, but does NOT print the password (Windows security feature). Real
  // password retrieval requires the Credential Manager API (CredRead) via a
  // native binding or a PowerShell helper using SecureString. Deferred to a
  // later phase — see UI.7 hand-off and task 1.17 risk-callouts.
  //
  // For now, on exit-0 we return an empty string sentinel so downstream knows
  // the credential exists. On non-zero exit (not found) or spawn-error we
  // return null. This behavior is illustrative and will be replaced.
  const target = `${service}:${account}`;
  const r = await runCapture(bin, [`/list:${target}`], timeoutMs);
  return r.code === 0 ? '' : null;
}

/**
 * Spawn `bin args`, capture stdout, kill via SIGTERM after `timeoutMs`.
 *
 * Returns `{ code, stdout }`. `code === -1` means the spawn itself failed
 * (e.g. binary not on PATH); `code !== 0` (and `code !== -1`) means the
 * subprocess ran but exited non-zero (e.g. "not found"). The public
 * `keychainBackend.resolve` collapses both into `null`, but the distinction
 * is preserved here for future telemetry / setup-UI diagnostics.
 *
 * stderr is intentionally drained (so the pipe buffer doesn't fill and stall
 * the child) but discarded — we don't log secret-tool / security stderr,
 * because on some platforms it may echo the account name.
 */
function runCapture(bin: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    const t = setTimeout(() => proc.kill('SIGTERM'), timeoutMs);
    proc.stdout.on('data', (d: Buffer | string) => {
      stdout += typeof d === 'string' ? d : d.toString('utf8');
    });
    // Drain stderr to prevent pipe-buffer stall; do not retain.
    proc.stderr.on('data', (d: Buffer | string) => {
      void d;
    });
    proc.on('close', (code) => {
      clearTimeout(t);
      resolve({ code: code ?? -1, stdout });
    });
    proc.on('error', () => {
      clearTimeout(t);
      resolve({ code: -1, stdout: '' });
    });
  });
}
