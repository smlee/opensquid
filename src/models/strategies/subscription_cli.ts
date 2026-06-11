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
 * Lifecycle (SUB.2, wg-627effbb2c38): owned by the SHARED helper
 * `runtime/spawn_lifecycle.ts` — explicit lifecycle FSM, detached group
 * leadership, SIGTERM → ref'd 5s grace → process-group SIGKILL, and the
 * SUB.1 `OPENSQUID_SUBAGENT` hook-silencing marker (this site spawns
 * REVIEWERS — they must never own coding-flow state). The >64KB
 * stdin-pipe deadlock limitation is documented there (Phase-2 scope).
 *
 * Exit-code contract (preserved through the helper):
 *   - exit 0   → resolve(stdout.trim())
 *   - exit ≠ 0 → reject(Error(`exit ${code}: ${stderr.trim()}`))
 *   - spawn error (ENOENT etc.) → reject(Error('spawn failed: …'))
 *   - timeout  → SIGTERM + reject(CliTimeoutError('timeout after Xms'))
 *
 * Imports from: ../../runtime/spawn_lifecycle.js, ../types.js.
 * Imported by: models/dispatcher.ts.
 */

import { runOneShotCli } from '../../runtime/spawn_lifecycle.js';

import type { ModelAliasConfig, ModelStrategy } from '../types.js';

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Typed timeout rejection so callers classify by TYPE, never by message text
 * (T-AUDIT-SPAWN-FIX — the spawn ledger counts `timeout` vs `error` outcomes).
 * Message stays byte-identical to the historical `timeout after Xms` string.
 */
export class CliTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`timeout after ${timeoutMs}ms`);
    this.name = 'CliTimeoutError';
  }
}

export function subscriptionCliStrategy(cfg: ModelAliasConfig): ModelStrategy {
  return {
    async call(prompt: string, opts?: { timeoutMs?: number }): Promise<string> {
      if (!cfg.cli) {
        throw new Error('subscription/cli strategy requires `cli` (the host binary name or path)');
      }
      const cliBin = cfg.cli;
      const args = cfg.args ?? [];
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

      // SUB.2 (wg-627effbb2c38): the spawn lifecycle (detached group
      // leadership, SIGTERM -> ref'd grace -> group SIGKILL, the SUB.1
      // OPENSQUID_SUBAGENT marker) lives in the SHARED helper — one
      // implementation for this site and the agent-bridge client. The
      // reviewer child tree is hook-silenced via markSubagent.
      const out = await runOneShotCli({
        cli: cliBin,
        args,
        prompt,
        timeoutMs,
        markSubagent: true,
        timeoutError: (ms) => new CliTimeoutError(ms),
      });
      return out.trim();
    },
  };
}
