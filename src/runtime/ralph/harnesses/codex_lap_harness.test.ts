/**
 * MHL.8 — the Codex adapter over a FAKE JSONL fixture in the LIVE-confirmed codex-cli 0.144.0 shape
 * (T-multi-harness-lap): the flag array (defaults + config-driven), stdin delivery, the fail-loud auth
 * preflight, and the JSONL fold (agent_message concat, turn.completed.usage tokens, notional-0 cost, error/
 * empty/malformed-line handling). NO real `codex` here — the only real-binary test is the opt-in live smoke.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  codexLapHarness,
  codexLapCostUsd,
  classifyCodexBilling,
  codexLoginStatus,
  assertCodexBillingCounted,
} from './codex_lap_harness.js';
import { outcomeFromEnvelope } from '../lap_outcome.js';
import type { CodexPricing, LapEnvelope, LapHarnessCfg } from '../lap_harness.js';

/** Build a fake `codex exec --json` JSONL stream in the verified 0.144.0 shape. */
const jsonl = (message: string, usage = { input_tokens: 12315, output_tokens: 19 }): string =>
  [
    JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_0', type: 'agent_message', text: message },
    }),
    JSON.stringify({ type: 'turn.completed', usage }),
  ].join('\n');

describe('codexLapHarness.spawnArgs + deliverPrompt (MHL.5)', () => {
  it('defaults: workspace-write / approval never / stdin prompt', () => {
    expect(codexLapHarness.spawnArgs({ maxBudgetUsd: 10 })).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'workspace-write',
      '-c',
      'approval_policy=never',
      '-',
    ]);
  });

  it('config-driven sandbox + approval flow into the flags (never --dangerously-bypass-*)', () => {
    const args = codexLapHarness.spawnArgs({
      maxBudgetUsd: 10,
      sandbox: 'read-only',
      askForApproval: 'on-failure',
    });
    expect(args).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'read-only',
      '-c',
      'approval_policy=on-failure',
      '-',
    ]);
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('deliverPrompt sends the prompt via stdin (parity with Claude)', () => {
    expect(codexLapHarness.deliverPrompt('X')).toEqual({ stdin: 'X' });
  });
});

const PRICING: CodexPricing = {
  models: { 'gpt-5-codex': { inputPerMTok: 1.25, outputPerMTok: 10 } },
  default: 'gpt-5-codex',
};

describe('codexLapHarness.preflight (auth diagnostics + billing-path detect + fail-closed refuse, MHL.5/CFS.2/CFS.3)', () => {
  // Hermetic: drive the real preflight via a temp HOME (os.homedir() reads process.env.HOME on POSIX) + the
  // real env keys, save/restore all — no builtin mocking (node:fs/os named imports can't be redefined). PATH is
  // emptied so `codexLoginStatus` (execFile 'codex') can't resolve the binary → returns null → the classifier
  // falls to the fully-controlled local env/auth.json signals: deterministic, NO real `codex login` spawn.
  const saved = {
    codex: process.env.CODEX_API_KEY,
    openai: process.env.OPENAI_API_KEY,
    home: process.env.HOME,
    path: process.env.PATH,
  };
  let tmp: string;
  const keyOf = (k: string): string =>
    k === 'codex'
      ? 'CODEX_API_KEY'
      : k === 'openai'
        ? 'OPENAI_API_KEY'
        : k === 'home'
          ? 'HOME'
          : 'PATH';
  beforeEach(() => {
    process.env.PATH = ''; // null out codexLoginStatus → local-signal classification (no real spawn)
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      const key = keyOf(k);
      if (v === undefined) delete process.env[key];
      else process.env[key] = v;
    }
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  // A temp HOME with NO auth.json (the metered-API hazard case) or WITH one (the subscription case).
  const withHome = (auth: boolean): void => {
    tmp = mkdtempSync(join(tmpdir(), auth ? 'codex-auth-' : 'codex-noauth-'));
    if (auth) {
      mkdirSync(join(tmp, '.codex'));
      writeFileSync(join(tmp, '.codex', 'auth.json'), '{}');
    }
    process.env.HOME = tmp;
  };

  it('throws fail-loud when no env key and no ~/.codex/auth.json (total-absence presence throw)', async () => {
    delete process.env.CODEX_API_KEY;
    delete process.env.OPENAI_API_KEY;
    withHome(false);
    await expect(codexLapHarness.preflight?.({ maxBudgetUsd: 10 })).rejects.toThrow(
      /Codex auth not found/,
    );
  });

  it('subscription path (auth.json present) proceeds even with NO pricing', async () => {
    delete process.env.CODEX_API_KEY;
    delete process.env.OPENAI_API_KEY;
    withHome(true);
    await expect(codexLapHarness.preflight?.({ maxBudgetUsd: 10 })).resolves.toBeUndefined();
  });

  it('CFS.3: an inherited API key (env key, NO auth.json) with NO pricing is REFUSED fail-loud', async () => {
    process.env.CODEX_API_KEY = 'sk-test';
    delete process.env.OPENAI_API_KEY;
    withHome(false); // no auth.json → env-key billing = the api hazard; no pricing → accounting not real
    await expect(codexLapHarness.preflight?.({ maxBudgetUsd: 10 })).rejects.toThrow(/refused/);
  });

  it('CFS.3: an API-path lap WITH pricing configured proceeds (accounting is real)', async () => {
    process.env.CODEX_API_KEY = 'sk-test';
    delete process.env.OPENAI_API_KEY;
    withHome(false);
    await expect(
      codexLapHarness.preflight?.({ maxBudgetUsd: 10, pricing: PRICING }),
    ).resolves.toBeUndefined();
  });

  it('CFS.2: preflight SURFACES the detected billing path on stderr (no real spawn)', async () => {
    delete process.env.CODEX_API_KEY;
    delete process.env.OPENAI_API_KEY;
    withHome(true); // auth.json → subscription
    const lines: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: unknown }).write = (chunk: string): boolean => {
      lines.push(String(chunk));
      return true;
    };
    try {
      await codexLapHarness.preflight?.({ maxBudgetUsd: 10 });
    } finally {
      (process.stderr as { write: unknown }).write = orig;
    }
    expect(lines.join('')).toMatch(/Codex effective billing path: subscription/);
  });
});

describe('codexLapHarness.parseEnvelope — the JSONL fold (MHL.5)', () => {
  it('folds the live shape → SHIPPED via extractTypedExit + real tokens + notional-0 cost', () => {
    const env = codexLapHarness.parseEnvelope(
      jsonl('done\nRALPH-EXIT: {"kind":"SHIPPED","stage":"code"}'),
      '',
    );
    expect(env).toMatchObject({ costUsd: 0, inputTokens: 12315, outputTokens: 19, isError: false });
    expect(env.resultText).toContain('RALPH-EXIT');
    expect(outcomeFromEnvelope(env).outcome).toEqual({ kind: 'SHIPPED', stage: 'code' });
  });

  it('concatenates multiple agent_message texts in stream order', () => {
    const stream = [
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'first' } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'second' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2 } }),
    ].join('\n');
    expect(codexLapHarness.parseEnvelope(stream, '').resultText).toBe('first\nsecond');
  });

  it('a WEDGE-tagged message → WEDGE through the fold', () => {
    const env = codexLapHarness.parseEnvelope(jsonl('RALPH-EXIT: {"kind":"WEDGE"}'), '');
    expect(outcomeFromEnvelope(env).outcome).toEqual({ kind: 'WEDGE' });
  });

  it('an error event → isError', () => {
    expect(
      codexLapHarness.parseEnvelope(JSON.stringify({ type: 'error', message: 'boom' }), '').isError,
    ).toBe(true);
    expect(codexLapHarness.parseEnvelope(JSON.stringify({ type: 'turn.failed' }), '').isError).toBe(
      true,
    );
  });

  it('an empty/whitespace stream → isError (no turn.completed)', () => {
    expect(codexLapHarness.parseEnvelope('', '').isError).toBe(true);
    expect(codexLapHarness.parseEnvelope('\n  \n', '').isError).toBe(true);
  });

  it('FCE.2: a refusal message with NO turn.completed → isError → CRASH (not SHIPPED)', () => {
    const stdout = JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: "I can't access the workgraph" },
    });
    const env = codexLapHarness.parseEnvelope(stdout, '');
    expect(env.isError).toBe(true);
    expect(env.resultText).toContain("I can't access");
    expect(outcomeFromEnvelope(env).outcome).toEqual({ kind: 'CRASH' });
  });

  it('FCE.1: a completed turn with NO tag → not-errored, but CRASH via the fail-closed fold', () => {
    const env = codexLapHarness.parseEnvelope(jsonl('all done, everything looks good'), '');
    expect(env.isError).toBe(false);
    expect(outcomeFromEnvelope(env).outcome).toEqual({ kind: 'CRASH' });
  });

  it('a malformed line interleaved with valid events is skipped, not fatal', () => {
    const stream = [
      '{ not json',
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }),
      'garbage}}}',
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 6 } }),
    ].join('\n');
    const env = codexLapHarness.parseEnvelope(stream, '');
    expect(env).toMatchObject({
      resultText: 'ok',
      inputTokens: 5,
      outputTokens: 6,
      isError: false,
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// CFS — Codex financial safety (real dollar accounting + effective-billing detection + fail-closed refuse).
// ---------------------------------------------------------------------------------------------------------------

const envOf = (inputTokens: number, outputTokens: number): LapEnvelope => ({
  resultText: '',
  costUsd: 0,
  inputTokens,
  outputTokens,
  isError: false,
});
const cfgOf = (pricing?: CodexPricing, model?: string): LapHarnessCfg => ({
  maxBudgetUsd: 10,
  ...(model === undefined ? {} : { model }),
  ...(pricing === undefined ? {} : { pricing }),
});

describe('CFS.1 — codexLapCostUsd: real per-model dollar accounting', () => {
  it('usage → non-zero costUsd = (in/1e6)*inRate + (out/1e6)*outRate (exact arithmetic)', () => {
    // 1M in @ $1.25/1M = 1.25 ; 0.5M out @ $10/1M = 5 ; total = 6.25.
    expect(codexLapCostUsd(envOf(1_000_000, 500_000), cfgOf(PRICING))).toBeCloseTo(6.25);
  });

  it('the units are $/1M-token, not $/token (a missing /1e6 would be off by 1e6)', () => {
    expect(codexLapCostUsd(envOf(2_000_000, 0), cfgOf(PRICING))).toBeCloseTo(2.5); // NOT 2.5e6
  });

  it('resolves the rate by cfg.model over pricing.default', () => {
    const pricing: CodexPricing = {
      models: {
        cheap: { inputPerMTok: 1, outputPerMTok: 1 },
        pricey: { inputPerMTok: 100, outputPerMTok: 100 },
      },
      default: 'cheap',
    };
    expect(codexLapCostUsd(envOf(1_000_000, 0), cfgOf(pricing, 'pricey'))).toBeCloseTo(100);
    expect(codexLapCostUsd(envOf(1_000_000, 0), cfgOf(pricing))).toBeCloseTo(1); // falls to default
  });

  it('an unknown/unresolved model with a non-empty map over-counts via the HIGHEST input rate', () => {
    const pricing: CodexPricing = {
      models: {
        cheap: { inputPerMTok: 1, outputPerMTok: 1 },
        pricey: { inputPerMTok: 100, outputPerMTok: 2 },
      },
    };
    // No cfg.model, no default → conservative fallback = the highest-inputPerMTok entry (pricey), NOT cheap.
    expect(codexLapCostUsd(envOf(1_000_000, 1_000_000), cfgOf(pricing))).toBeCloseTo(102);
  });

  it('an absent OR empty pricing map ⇒ 0 (subscription-safe; unchanged)', () => {
    expect(codexLapCostUsd(envOf(9e5, 9e5), cfgOf())).toBe(0);
    expect(codexLapCostUsd(envOf(9e5, 9e5), cfgOf({ models: {} }))).toBe(0);
  });

  it('the adapter wires codexLapCostUsd as its priceUsd seam', () => {
    expect(codexLapHarness.priceUsd?.(envOf(1_000_000, 0), cfgOf(PRICING))).toBeCloseTo(1.25);
  });

  it('spawnArgs includes -m <model> iff cfg.model is set (run == priced)', () => {
    expect(codexLapHarness.spawnArgs(cfgOf(PRICING, 'gpt-5-codex'))).toContain('-m');
    expect(codexLapHarness.spawnArgs(cfgOf(PRICING, 'gpt-5-codex'))).toContain('gpt-5-codex');
    expect(codexLapHarness.spawnArgs(cfgOf(PRICING))).not.toContain('-m');
  });
});

describe('CFS.2 — classifyCodexBilling: effective-billing-path detection (auth.json precedence)', () => {
  it('ChatGPT status + env key ⇒ subscription (THE auth.json-precedence case)', () => {
    expect(
      classifyCodexBilling('Logged in using ChatGPT', { hasAuthFile: true, hasEnvKey: true }),
    ).toBe('subscription');
  });

  it('an "API key" status ⇒ api', () => {
    expect(
      classifyCodexBilling('Logged in using an API key', { hasAuthFile: false, hasEnvKey: true }),
    ).toBe('api');
  });

  it('status null + hasAuthFile ⇒ subscription (local precedence fallback)', () => {
    expect(classifyCodexBilling(null, { hasAuthFile: true, hasEnvKey: true })).toBe('subscription');
  });

  it('status null + env key only ⇒ api (the metered-API hazard)', () => {
    expect(classifyCodexBilling(null, { hasAuthFile: false, hasEnvKey: true })).toBe('api');
  });

  it('status null + no signals ⇒ unknown', () => {
    expect(classifyCodexBilling(null, { hasAuthFile: false, hasEnvKey: false })).toBe('unknown');
  });

  it('codexLoginStatus returns null on an unresolvable binary (never throws)', async () => {
    const savedPath = process.env.PATH;
    process.env.PATH = ''; // 'codex' can't resolve → execFile ENOENT → caught → null
    try {
      await expect(codexLoginStatus()).resolves.toBeNull();
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
    }
  });
});

describe('CFS.3 — assertCodexBillingCounted: fail-closed refuse of uncounted API laps', () => {
  it('api + no pricing ⇒ throws /refused/', () => {
    expect(() => assertCodexBillingCounted('api', cfgOf())).toThrow(/refused/);
    expect(() => assertCodexBillingCounted('api', cfgOf({ models: {} }))).toThrow(/refused/);
  });

  it('api + real pricing ⇒ does NOT throw', () => {
    expect(() => assertCodexBillingCounted('api', cfgOf(PRICING))).not.toThrow();
  });

  it('subscription NEVER throws (regardless of pricing)', () => {
    expect(() => assertCodexBillingCounted('subscription', cfgOf())).not.toThrow();
    expect(() => assertCodexBillingCounted('subscription', cfgOf(PRICING))).not.toThrow();
  });

  it('unknown (no env key, no signals) does NOT throw — only the api path is refused', () => {
    expect(() => assertCodexBillingCounted('unknown', cfgOf())).not.toThrow();
  });

  it('the refuse message names both fixes (configure pricing OR use subscription)', () => {
    expect(() => assertCodexBillingCounted('api', cfgOf())).toThrow(/harness\.pricing/);
    expect(() => assertCodexBillingCounted('api', cfgOf())).toThrow(/subscription/);
  });
});
