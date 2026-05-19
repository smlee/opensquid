/**
 * `subscription + cli` strategy: spawn the user's host binary, pipe the
 * prompt via stdin, capture stdout. The only Phase-1 concrete strategy.
 *
 * Model neutrality contract (per `project_opensquid_model_neutral_subagent_primitive`
 * and the model-name-drift feedback memory): NO vendor identity lives in
 * this file. `cfg.cli` is the binary name/path supplied by the user's
 * `models.yaml`; opensquid treats it as an opaque string. The audit-grep
 * defined in the task spec must return empty against this file.
 *
 * Lifecycle:
 *   1. spawn(cli, args) with stdio: ['pipe', 'pipe', 'pipe']
 *   2. setTimeout(timeoutMs ?? 30_000) — on fire, SIGTERM the child + reject
 *   3. write the prompt to stdin and end it (signals EOF to the binary)
 *   4. accumulate stdout / stderr
 *   5. on close: clearTimeout; exit 0 → resolve stdout.trim(); else reject
 *      with stderr-tagged message
 *
 * Phase-1 limitation — stdin/stdout deadlock for >64KB prompts:
 *   Node's pipe stdio uses OS pipe buffers (~64KB on Linux/macOS). For a
 *   very large prompt, `proc.stdin.write(prompt)` can fill the kernel buffer
 *   before the child has read enough, and the child may concurrently fill
 *   its stdout buffer waiting for us to drain — classic mutual-deadlock.
 *   Phase 1 documents this limit; Phase 2 (cross-cutting LLM track) adds a
 *   temp-file fallback for prompts above the threshold. Do NOT add a stdin
 *   `drain` handler here without the temp-file path landing — partial
 *   mitigations have hidden failure modes.
 *
 * Exit-code contract:
 *   - exit 0   → resolve(stdout.trim())
 *   - exit ≠ 0 → reject(Error(`exit ${code}: ${stderr.trim()}`))
 *   - spawn error (ENOENT etc.) → reject via `proc.on('error')`
 *   - timeout  → SIGTERM + reject(Error('timeout after Xms'))
 *
 * Imports from: node:child_process, ../types.js.
 * Imported by: models/dispatcher.ts.
 */

import { spawn } from 'node:child_process';

import type { ModelAliasConfig, ModelStrategy } from '../types.js';

const DEFAULT_TIMEOUT_MS = 30_000;

export function subscriptionCliStrategy(cfg: ModelAliasConfig): ModelStrategy {
  return {
    async call(prompt: string, opts?: { timeoutMs?: number }): Promise<string> {
      if (!cfg.cli) {
        throw new Error('subscription/cli strategy requires `cli` (the host binary name or path)');
      }
      const cliBin = cfg.cli;
      const args = cfg.args ?? [];
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

      return new Promise<string>((resolve, reject) => {
        const proc = spawn(cliBin, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        let settled = false;

        // Idempotent settlement: spawn-error, exit, and timeout can race
        // (e.g. timer fires while close is already in flight); first one
        // wins, the others are no-ops.
        const settle = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          fn();
        };

        const timer = setTimeout(() => {
          // SIGTERM lets the child clean up; if it ignores SIGTERM the
          // process leaks until OS kills it — acceptable Phase 1 trade-off
          // (the kernel reaps eventually, and we've already rejected the
          // promise so the caller is unblocked).
          proc.kill('SIGTERM');
          settle(() => reject(new Error(`timeout after ${timeoutMs}ms`)));
        }, timeoutMs);

        proc.stdout.on('data', (d: Buffer) => {
          stdout += d.toString('utf8');
        });
        proc.stderr.on('data', (d: Buffer) => {
          stderr += d.toString('utf8');
        });

        proc.on('error', (e) => {
          // ENOENT (cli not on PATH), EACCES (not executable), etc. The
          // 'close' event may or may not fire after 'error' — settle here
          // to avoid both firing.
          settle(() => reject(new Error(`spawn failed: ${e.message}`)));
        });

        proc.on('close', (code) => {
          settle(() => {
            if (code === 0) {
              resolve(stdout.trim());
            } else {
              reject(new Error(`exit ${code}: ${stderr.trim()}`));
            }
          });
        });

        // stdin.end() flushes the prompt and signals EOF to the binary.
        // Wrapped in try/catch because the child may have already exited
        // (e.g. spawn error fired synchronously on Windows) and writing
        // to a closed stream throws EPIPE.
        try {
          proc.stdin.write(prompt);
          proc.stdin.end();
        } catch (e) {
          settle(() => reject(new Error(`stdin write failed: ${String(e)}`)));
        }
      });
    },
  };
}
