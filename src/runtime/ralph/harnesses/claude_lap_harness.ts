/**
 * MHL.4 — the Claude lap adapter (T-multi-harness-lap): TODAY'S Claude behavior, extracted VERBATIM.
 *
 * This is the regression FLOOR — byte-identical args, stdin-delivered prompt, single-JSON-envelope parse. It
 * is the ONLY neutral-core-adjacent place the Claude invocation flags + envelope field names live (the audit-
 * grep-empty over the core, MHL.8, EXPECTS the hits HERE, exactly like `api_anthropic.ts` names its vendor).
 *
 * Extracted from: src/setup/cli/ralph.ts:137-145 (the args + the stdin prompt) + src/runtime/ralph/
 * lap_outcome.ts (the former parseLapOutcome's Claude envelope reader + readUsage). Any deviation is a Claude
 * regression the neutral refactor must NOT introduce (claude_lap_harness.test.ts pins byte-identity).
 */
import type { LapEnvelope, LapHarness, LapHarnessCfg } from '../lap_harness.js';

/** Read `usage.input_tokens`/`usage.output_tokens` from the headless envelope (0 when absent). Moved here from
 *  lap_outcome.ts so the neutral core holds NO vendor field name (audit-grep-empty). */
function readUsage(env: Record<string, unknown>): { inputTokens: number; outputTokens: number } {
  const u = env.usage;
  if (u === null || typeof u !== 'object') return { inputTokens: 0, outputTokens: 0 };
  const rec = u as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
  return { inputTokens: num(rec.input_tokens), outputTokens: num(rec.output_tokens) };
}

export const claudeLapHarness: LapHarness = {
  // ralph.ts:137-144 VERBATIM — -p + JSON output, the dollar bound, skip-permissions. No behavior change.
  spawnArgs: (cfg: LapHarnessCfg): string[] => [
    '-p',
    '--output-format',
    'json',
    '--max-budget-usd',
    String(cfg.maxBudgetUsd),
    '--dangerously-skip-permissions',
  ],
  // `claude -p` reads the prompt from stdin (ralph.ts:145 convention).
  deliverPrompt: (prompt: string): { stdin: string } => ({ stdin: prompt }),
  // The single-JSON-envelope reader, extracted from parseLapOutcome:116-131 VERBATIM. Unparseable/non-object
  // stdout ⇒ isError:true (→ CRASH via outcomeFromEnvelope), preserving today's total mapping.
  parseEnvelope: (stdout: string, _stderr: string): LapEnvelope => {
    let env: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(stdout);
      if (parsed === null || typeof parsed !== 'object')
        return { resultText: '', costUsd: 0, inputTokens: 0, outputTokens: 0, isError: true };
      env = parsed as Record<string, unknown>;
    } catch {
      return { resultText: '', costUsd: 0, inputTokens: 0, outputTokens: 0, isError: true };
    }
    const costUsd = typeof env.total_cost_usd === 'number' ? env.total_cost_usd : 0;
    const { inputTokens, outputTokens } = readUsage(env);
    const isError = env.is_error === true;
    const resultText = typeof env.result === 'string' ? env.result : '';
    return { resultText, costUsd, inputTokens, outputTokens, isError };
  },
  // No preflight — Claude auth is inherited from the ambient env (today's behavior has none; omit → byte-unchanged).
};
