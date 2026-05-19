/**
 * 1Password CLI subprocess backend for the secrets resolver.
 *
 * Resolves `op://vault/item/field` references by shelling out to the `op` CLI
 * (https://developer.1password.com/docs/cli/) and capturing stdout. `validate()`
 * runs `op whoami` to confirm the binary is present and authenticated.
 *
 * Subprocess discipline:
 *   - `stdio: ['ignore', 'pipe', 'pipe']` — no stdin (op read doesn't need it),
 *     captured stdout + stderr.
 *   - SIGTERM after `timeoutMs` (default 5000) to avoid blocking on a Touch ID
 *     prompt or hung network call.
 *   - Spawn errors (binary missing) become `{ code: -1, stderr: 'spawn failed' }`
 *     so the caller treats them as "unresolvable" instead of throwing.
 *
 * Security:
 *   - NEVER log resolved secret values. Only exit codes / stderr land in logs,
 *     and that only at the caller's discretion — this module logs nothing.
 *
 * macOS gotcha (see post-research note): without `OP_SERVICE_ACCOUNT_TOKEN`, the
 * `op` CLI may pop a Touch ID prompt on first use. The 5s timeout catches the
 * stall, but the setup UI should warn users to configure a service account
 * token for non-interactive contexts.
 *
 * Imports from: node:child_process, ../types.js.
 * Imported by: src/secrets/index.ts.
 */

import { spawn } from 'node:child_process';

import type { SecretBackend } from '../types.js';

export interface OpBackendOptions {
  /** Path or PATH-resolvable name of the 1Password CLI binary. Default 'op'. */
  binary?: string;
  /** Subprocess timeout in ms. Default 5000. */
  timeoutMs?: number;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function opBackend(opts: OpBackendOptions = {}): SecretBackend {
  const bin = opts.binary ?? 'op';
  const timeout = opts.timeoutMs ?? 5000;

  return {
    scheme: 'op',
    async validate(): Promise<{ ok: boolean; error?: string }> {
      const r = await runOp(bin, ['whoami'], timeout);
      return r.code === 0 ? { ok: true } : { ok: false, error: r.stderr };
    },
    async resolve(ref: string): Promise<string | null> {
      // ref is the path after `op://`, e.g. `vault/item/field`.
      const r = await runOp(bin, ['read', `op://${ref}`], timeout);
      if (r.code !== 0) return null;
      return r.stdout.trim();
    },
  };
}

function runOp(bin: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const t = setTimeout(() => proc.kill('SIGTERM'), timeoutMs);
    proc.stdout.on('data', (d: Buffer | string) => {
      stdout += typeof d === 'string' ? d : d.toString('utf8');
    });
    proc.stderr.on('data', (d: Buffer | string) => {
      stderr += typeof d === 'string' ? d : d.toString('utf8');
    });
    proc.on('close', (code) => {
      clearTimeout(t);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    proc.on('error', () => {
      clearTimeout(t);
      resolve({ code: -1, stdout, stderr: 'spawn failed' });
    });
  });
}
