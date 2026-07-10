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
 *   - COST (CFS.1): the stream carries NO total_cost_usd, so `parseEnvelope` returns a notional 0 at parse
 *     time with the REAL token counts recorded; the REAL dollar figure is folded post-parse by the optional
 *     `priceUsd` seam (`codexLapCostUsd` = tokens × the configured per-model $/1M rate, applied at the wire
 *     ralph.ts). `costUsd` is 0 ONLY when no `harness.pricing` is configured — a subscription lap (wall-clock,
 *     not dollars, is the bound; no per-lap dollar risk) or an API lap already REFUSED by the fail-closed
 *     preflight gate (assertCodexBillingCounted) — so an autonomous API lap never bills metered while
 *     accounting $0.
 *   - `--output-schema` (Codex P1 #4, FCE.3): SUPPORTED by codex-cli 0.144.0 (`codex exec --output-schema
 *     <FILE>` — a JSON Schema file for the model's FINAL response shape) but DELIBERATELY DEFERRED. It
 *     constrains the ENTIRE final response to schema-JSON, which is incompatible with the embedded-`RALPH-EXIT:`
 *     -line free-text exit contract (RALPH.md; the authoritative text-parse fold in lap_outcome.ts) — a
 *     pure-JSON final message has no `RALPH-EXIT:` line, so the fail-closed fold would read every Codex lap as
 *     absent-tag → CRASH. Adopting it would require reshaping the exit contract across RALPH.md + both adapters
 *     + the fold, making an OPTIONAL element load-bearing/coupled — out of scope (§5-Q2: additive, version-
 *     gated, NEVER a hard dependency). The text-parse path (the fail-closed fold + the turn.completed predicate)
 *     remains the SOLE enforcement. Revisit only if a future Codex constrains a SUB-field (not the whole
 *     response) or the exit contract is redesigned to a pure-JSON envelope; re-fact-check the binary then.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { LapEnvelope, LapHarness, LapHarnessCfg } from '../lap_harness.js';

const execFileP = promisify(execFile);

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
    // CFS.1 — when a model is resolved, pass it so the model that RUNS is the model that is PRICED (no
    // run-vs-price drift). Absent ⇒ Codex's own default (priced via pricing.default / the conservative fallback).
    ...(cfg.model === undefined ? [] : ['-m', cfg.model]),
    '-',
  ],
  // `codex exec -` reads the prompt from stdin (parity with the Claude lap; LIVE-confirmed).
  deliverPrompt: (prompt: string): { stdin: string } => ({ stdin: prompt }),
  // FAIL-LOUD auth diagnostics BEFORE the lap — a setup problem surfaced before the spawn, NOT a retryable
  // CRASH (mirrors the RALPH.md-not-found throw, ralph.ts:107). Sequence (CFS.2/CFS.3): (a) the total-absence
  // presence throw; (b) detect + SURFACE the EFFECTIVE billing path from the ACTUAL credential; (c) fail-CLOSED
  // REFUSE an API-billed lap whose dollar accounting is not real.
  preflight: async (cfg: LapHarnessCfg): Promise<void> => {
    const hasEnv = !!process.env.CODEX_API_KEY || !!process.env.OPENAI_API_KEY;
    // CE.3 — $CODEX_HOME-aware auth.json (was hardcoded ~/.codex): a valid login under a custom $CODEX_HOME
    // must not be missed. The AUTH-path half of the two-readers-of-one-source lock (mcp-hosts.ts resolveCodexHome
    // is the HOST-path half — the same 1-liner, read independently to keep the setup/lap scopes disjoint).
    const codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');
    const hasAuthFile = existsSync(join(codexHome, 'auth.json'));
    // CE.3 — shell `codex login status` ONCE at the top, reused for BOTH presence AND billing (no double spawn).
    const loginStatus = await codexLoginStatus();
    // CE.3 — PRESENCE via the login authority: env key OR $CODEX_HOME auth.json OR a positive `codex login status`.
    // A true total absence still fails-loud before the spawn (a setup error, NOT a retryable CRASH).
    if (!hasCodexAuth(loginStatus, { hasEnvKey: hasEnv, hasAuthFile }))
      throw new Error(
        'Codex auth not found — set CODEX_API_KEY/OPENAI_API_KEY, run `codex login`, or set $CODEX_HOME ' +
          'to your auth.json location (fail-loud before the lap)',
      );
    // CFS.2 — bind the effective billing to the ACTUAL credential (not the authMode config), and SURFACE it on
    // the LIVE stderr channel (ralph.ts streams each preflight stderr line) so the truth is observable. Reuses
    // the SAME loginStatus string (no second `codex login status` spawn).
    const path = classifyCodexBilling(loginStatus, { hasAuthFile, hasEnvKey: hasEnv });
    process.stderr.write(
      `Codex effective billing path: ${path} (authMode config: informational)\n`,
    );
    // CFS.3 — fail-CLOSED: refuse an API-billed autonomous lap with no real dollar accounting.
    assertCodexBillingCounted(path, cfg);
  },
  parseEnvelope: (stdout: string, _stderr: string): LapEnvelope => {
    let resultText = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let sawError = false;
    let sawCompletion = false;
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
    // Tightened (Codex P1 #4): require a GENUINE completion signal. A stream error OR the absence of
    // turn.completed (a refusal message, an aborted/empty stream) ⇒ errored ⇒ CRASH via outcomeFromEnvelope.
    // A refusal MESSAGE alone is NO LONGER success — it never completed a turn.
    const isError = sawError || !sawCompletion;
    // CFS.1: the JSONL carries NO total_cost_usd → a notional 0 at parse time + REAL token counts; the REAL
    // dollar figure is folded post-parse by `priceUsd` (codexLapCostUsd) at the wire. parseEnvelope body stays
    // byte-identical (the FCE.2 isError predicate + the token fold are the regression floor).
    return { resultText, costUsd: 0, inputTokens, outputTokens, isError };
  },
  // CFS.1 — the post-parse dollar pricing seam: costUsd = tokens × the configured per-model rate (Claude omits
  // this; its total_cost_usd is already real). Applied at the wire between parseEnvelope and outcomeFromEnvelope.
  priceUsd: codexLapCostUsd,
};

/**
 * CFS.1 — the pure per-model dollar fold (Q1 locks): resolve the model (cfg.model ?? pricing.default), price by
 * its rate; an unknown/unresolved model with a NON-EMPTY map falls back to the HIGHEST input rate (a conservative
 * OVER-count — the budget trips EARLIER, never later; under-counting a financial bound is the unsafe direction);
 * an absent/empty pricing map ⇒ 0 (a subscription lap, or an API lap already refused by CFS.3). Total, never throws.
 */
export function codexLapCostUsd(env: LapEnvelope, cfg: LapHarnessCfg): number {
  const p = cfg.pricing;
  if (!p || Object.keys(p.models).length === 0) return 0;
  const modelId = cfg.model ?? p.default;
  const rate =
    (modelId !== undefined ? p.models[modelId] : undefined) ??
    Object.values(p.models).reduce((hi, r) => (r.inputPerMTok > hi.inputPerMTok ? r : hi));
  return (
    (env.inputTokens / 1e6) * rate.inputPerMTok + (env.outputTokens / 1e6) * rate.outputPerMTok
  );
}

/**
 * CE.3 — auth PRESENCE (pure/total): auth is PRESENT iff an env key, OR an auth.json ($CODEX_HOME-resolved by
 * the caller), OR a POSITIVE `codex login status`. Keyed on the robust 0.144.0 phrasing ("Logged in using
 * ChatGPT"); the `!/not logged in/i` guard is load-bearing — without it "Not logged in" matches `/logged in/i`
 * and a logged-OUT machine would read as present and skip the fail-loud. REUSES the EXISTING codexLoginStatus
 * authority (the string is passed in — no spawn here). Never throws.
 */
export function hasCodexAuth(
  loginStatus: string | null,
  signals: { hasEnvKey: boolean; hasAuthFile: boolean },
): boolean {
  if (signals.hasEnvKey || signals.hasAuthFile) return true;
  return (
    loginStatus !== null && /logged in/i.test(loginStatus) && !/not logged in/i.test(loginStatus)
  );
}

/** CFS.2 — the EFFECTIVE Codex billing path. */
export type CodexBillingPath = 'subscription' | 'api' | 'unknown';

/**
 * CFS.2 — classify the EFFECTIVE Codex billing path. `codex login status` is the AUTHORITY; the local env/
 * auth.json signals are the precedence-honoring fallback — a cached ChatGPT login in ~/.codex/auth.json takes
 * PRECEDENCE over a stray env key (confirmed live: `codex login status` → "Logged in using ChatGPT" despite
 * an env key present). Pure, total. Keyed on robust substrings (the 0.144.0 phrasing) so a future rename still
 * classifies safely via the local-signal fallback.
 */
export function classifyCodexBilling(
  loginStatus: string | null,
  signals: { hasAuthFile: boolean; hasEnvKey: boolean },
): CodexBillingPath {
  if (loginStatus !== null) {
    const s = loginStatus.toLowerCase();
    if (/chatgpt|subscription/.test(s)) return 'subscription'; // "Logged in using ChatGPT" (confirmed 0.144.0)
    if (/api[ -]?key/.test(s)) return 'api';
  }
  if (signals.hasAuthFile) return 'subscription'; // auth.json precedence — a cached login bills subscription
  if (signals.hasEnvKey) return 'api'; // no auth.json + an env key → the metered-API hazard case
  return 'unknown';
}

/**
 * CFS.2 — the injectable shell seam (the AUTHORITY). Returns trimmed `codex login status` stdout, or null on any
 * error/timeout (the classifier then falls to the local signals). MUST never throw / hang the lap — a slow or
 * absent `codex login` degrades to null. Tests inject the string directly into classifyCodexBilling.
 */
export async function codexLoginStatus(): Promise<string | null> {
  try {
    const { stdout } = await execFileP('codex', ['login', 'status'], { timeout: 5000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

/** CFS.3 — accounting is "real" iff a non-empty pricing map can price the lap (mirrors codexLapCostUsd's
 *  empty-map ⇒ 0 condition exactly — the single shared source, so allow/refuse and price/0 never drift). */
function accountingIsReal(cfg: LapHarnessCfg): boolean {
  return !!cfg.pricing && Object.keys(cfg.pricing.models).length > 0;
}

/**
 * CFS.3 — fail-CLOSED: an autonomous lap on the metered-API path with NO real dollar accounting is REFUSED
 * before the spawn (throws fail-loud, NOT a retryable CRASH — a config problem a retry can't fix). Subscription
 * (no per-lap dollar risk) and API-with-real-pricing proceed. `'unknown'` never reaches here with an env key
 * present (classifyCodexBilling maps env-only → 'api'); a true `'unknown'` (no signals at all) is already
 * caught by the preflight presence throw. Pure, total.
 */
export function assertCodexBillingCounted(path: CodexBillingPath, cfg: LapHarnessCfg): void {
  if (path === 'api' && !accountingIsReal(cfg)) {
    throw new Error(
      'Codex API-billed lap refused — dollar accounting is not real (configure harness.pricing for the ' +
        'model, or use subscription auth). Fail-closed: an autonomous lap must not bill metered API while ' +
        'accounting $0.',
    );
  }
}
