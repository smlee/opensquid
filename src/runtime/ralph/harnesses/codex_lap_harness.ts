/**
 * MHL.5 — the Codex lap adapter (T-multi-harness-lap): drives a real `codex exec --json` lap.
 *
 * ALL Codex-specifics live HERE (the flags, the JSONL field names, the sandbox/approval defaults, the auth
 * preflight) — nowhere in the neutral core. The audit-grep-empty (MHL.8) EXPECTS the vendor hits in this file,
 * exactly like `api_openai.ts` legitimately names its vendor; it targets the CORE, not this adapter.
 *
 * Grounded in the LIVE codex-cli 0.144.0 surface (docs/tasks/T-multi-harness-lap.md — AUTHOR live-binary
 * confirmation) + docs/design/integration-codex-cli.md §1.5:
 *   - `codex exec --json --sandbox <mode> -c approval_policy=<v> -` (the prompt via stdin `-`, LIVE-confirmed).
 *   - `--json` emits a JSONL event stream; the fold concatenates every `item.completed{agent_message}.text`
 *     (the final message carries the RALPH-EXIT tag) and reads token usage from the last `turn.completed.usage`.
 *   - `--ask-for-approval` is NOT a `codex exec` flag in 0.144.0 → the explicit approval policy rides the
 *     config-override `-c approval_policy=<v>` (default `never`); the explicit sandbox rides `--sandbox`
 *     (default `workspace-write`) — NOT the reckless `--dangerously-bypass-approvals-and-sandbox` auto-skip.
 *   - COST: the stream carries NO total_cost_usd → costUsd is a DOCUMENTED notional 0 with the REAL token
 *     counts recorded, so loop_metrics stays populated (token columns real; the dollar column a documented 0
 *     for Codex subscription-style auth, consistent with the loop's subscription mode where wall-clock, not
 *     dollars, is the bound).
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { LapEnvelope, LapHarness, LapHarnessCfg } from '../lap_harness.js';

const DEFAULT_SANDBOX = 'workspace-write'; // explicit autonomous-lap policy (open-Q1) — NOT --dangerously-*
const DEFAULT_APPROVAL = 'never'; // explicit approval policy via -c approval_policy (open-Q1)

export const codexLapHarness: LapHarness = {
  // LIVE-confirmed (0.144.0): `codex exec --json --sandbox <mode> -c approval_policy=<v> -` (stdin prompt).
  // `exec` is the subcommand (the binary `codex` is file.harness.cli); `-` reads the prompt from stdin.
  spawnArgs: (cfg: LapHarnessCfg): string[] => [
    'exec',
    '--json',
    '--sandbox',
    cfg.sandbox ?? DEFAULT_SANDBOX,
    '-c',
    `approval_policy=${cfg.askForApproval ?? DEFAULT_APPROVAL}`,
    '-',
  ],
  // `codex exec -` reads the prompt from stdin (parity with the Claude lap; LIVE-confirmed).
  deliverPrompt: (prompt: string): { stdin: string } => ({ stdin: prompt }),
  // FAIL-LOUD auth diagnostics BEFORE the lap — a setup problem surfaced before the spawn, NOT a retryable
  // CRASH (mirrors the RALPH.md-not-found throw, ralph.ts:107).
  preflight: (_cfg: LapHarnessCfg): void => {
    const hasEnv = !!process.env.CODEX_API_KEY || !!process.env.OPENAI_API_KEY;
    const hasAuthFile = existsSync(join(homedir(), '.codex', 'auth.json'));
    if (!hasEnv && !hasAuthFile)
      throw new Error(
        'Codex auth not found — set CODEX_API_KEY/OPENAI_API_KEY or run `codex login` to seed ~/.codex/auth.json (fail-loud before the lap)',
      );
  },
  parseEnvelope: (stdout: string, _stderr: string): LapEnvelope => {
    let resultText = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let sawError = false;
    let sawCompletion = false;
    let sawMessage = false;
    for (const line of stdout.split('\n')) {
      const t = line.trim();
      if (t.length === 0) continue;
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(t) as Record<string, unknown>;
      } catch {
        continue; // skip a partial/garbage line — a malformed line must not crash the fold
      }
      const type = ev.type;
      if (type === 'item.completed') {
        const item = ev.item as Record<string, unknown> | undefined;
        if (item?.type === 'agent_message' && typeof item.text === 'string') {
          resultText += (resultText ? '\n' : '') + item.text;
          sawMessage = true;
        }
      } else if (type === 'turn.completed') {
        sawCompletion = true;
        const usage = ev.usage as Record<string, unknown> | undefined;
        if (usage) {
          if (typeof usage.input_tokens === 'number') inputTokens = usage.input_tokens;
          if (typeof usage.output_tokens === 'number') outputTokens = usage.output_tokens;
        }
      } else if (type === 'error' || type === 'turn.failed') {
        sawError = true; // CODE re-confirmed against the live binary — see the module header
      }
    }
    const isError = sawError || (!sawMessage && !sawCompletion); // stream error OR empty/aborted stream
    // open-Q2: the JSONL carries NO total_cost_usd → notional 0 cost + REAL token counts (loop_metrics stays populated).
    return { resultText, costUsd: 0, inputTokens, outputTokens, isError };
  },
};
