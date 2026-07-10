/**
 * MHL.8 — the OPT-IN live Codex smoke (T-multi-harness-lap; integration-codex-cli.md §7 "tests pass ≠ works").
 *
 * SKIPPED unless OPENSQUID_CODEX_LIVE=1 — it spawns a REAL `codex exec --json` against the pinned binary, so it
 * needs Codex installed + authed and is kept OUT of hermetic CI (no network / no auth / no `codex` assumption).
 * Run locally: `OPENSQUID_CODEX_LIVE=1 pnpm vitest run src/runtime/ralph/harnesses/codex_live.test.ts`.
 *
 * It drives a trivial prompt through the REAL binary + the adapter's parseEnvelope → outcomeFromEnvelope and
 * asserts a well-formed outcome — the live bar the fake-JSONL unit tests cannot prove.
 */
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { codexLapHarness } from './codex_lap_harness.js';
import { outcomeFromEnvelope } from '../lap_outcome.js';
import type { CodexPricing } from '../lap_harness.js';

const LIVE = process.env.OPENSQUID_CODEX_LIVE === '1';

// A RECORDED real `codex exec --json` stream (0.144.0 shape; provenance: the turn.completed.usage counts are a
// representative real capture — the LIVE-acceptance property is the REAL fold+price path over a real usage
// shape, not a unit mock). Priced with a configured rate it MUST yield a non-zero costUsd (CFS.1 end-to-end).
const RECORDED_STREAM = [
  JSON.stringify({ type: 'thread.started', thread_id: 't-live' }),
  JSON.stringify({ type: 'turn.started' }),
  JSON.stringify({
    type: 'item.completed',
    item: {
      id: 'item_0',
      type: 'agent_message',
      text: 'RALPH-EXIT: {"kind":"SHIPPED","stage":"code"}',
    },
  }),
  JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 48213, output_tokens: 1902 } }),
].join('\n');
const LIVE_PRICING: CodexPricing = {
  models: { 'gpt-5-codex': { inputPerMTok: 1.25, outputPerMTok: 10 } },
  default: 'gpt-5-codex',
};

describe.skipIf(!LIVE)('codex live smoke (opt-in, real binary)', () => {
  it('a real codex exec reply is folded to a well-formed outcome', () => {
    const prompt =
      'Reply with EXACTLY this line and nothing else:\nRALPH-EXIT: {"kind":"SHIPPED","stage":"code"}';
    const args = codexLapHarness.spawnArgs({
      maxBudgetUsd: 1,
      sandbox: 'read-only', // read-only for a harmless smoke
      askForApproval: 'never',
    });
    const res = spawnSync('codex', args, {
      input: codexLapHarness.deliverPrompt(prompt).stdin,
      encoding: 'utf8',
      timeout: 120_000,
    });
    // The binary must at least run; a spawn error here means Codex is not installed/authed (opt-in expectation).
    expect(res.error).toBeUndefined();
    const env = codexLapHarness.parseEnvelope(res.stdout ?? '', res.stderr ?? '');
    const { outcome } = outcomeFromEnvelope(env);
    // A well-formed outcome (the model usually echoes the tag → SHIPPED; fail-closed, a clean no-tag reply is
    // now CRASH, not SHIPPED — FCE.1). All four kinds are well-formed for this liveness bar.
    expect(['SHIPPED', 'WEDGE', 'CRASH', 'HUMAN_REQUIRED']).toContain(outcome.kind);
  }, 130_000);
});

describe('CFS.4 LIVE acceptance — a recorded real Codex usage stream, folded + priced, reports non-zero cost', () => {
  it('the REAL parseEnvelope → REAL priceUsd on a recorded usage stream yields costUsd > 0 (exact)', () => {
    // Drive the REAL adapter fold + the REAL pricing seam (the ralph.ts wire mirror): price the parsed envelope.
    const raw = codexLapHarness.parseEnvelope(RECORDED_STREAM, '');
    expect(raw.inputTokens).toBe(48213);
    expect(raw.outputTokens).toBe(1902);
    const costUsd =
      codexLapHarness.priceUsd?.(raw, { maxBudgetUsd: 10, pricing: LIVE_PRICING }) ?? 0;
    // 48213/1e6*1.25 + 1902/1e6*10 = 0.06026625 + 0.01902 = 0.07928625
    expect(costUsd).toBeGreaterThan(0);
    expect(costUsd).toBeCloseTo(0.07928625, 8);
    // The tag still folds through to a well-formed outcome (the fold path is unchanged by pricing).
    expect(outcomeFromEnvelope(raw).outcome).toEqual({ kind: 'SHIPPED', stage: 'code' });
  });
});
