/**
 * MHL.8 — the Claude adapter regression FLOOR (T-multi-harness-lap). Pins byte-identity of the extracted
 * behavior: the exact ralph.ts:137-144 flag array, the stdin prompt, and the single-JSON-envelope reads
 * (total_cost_usd/usage/is_error/result) — including the unparseable/non-object → isError path. These mirror
 * the former parseLapOutcome cases (see lap_outcome.test.ts) so the extraction is proven behavior-preserving.
 */
import { describe, expect, it } from 'vitest';

import { claudeLapHarness } from './claude_lap_harness.js';
import { outcomeFromEnvelope } from '../lap_outcome.js';

describe('claudeLapHarness (MHL.4)', () => {
  it('spawnArgs is byte-identical to the former hardcoded Claude array (ralph.ts:137-144)', () => {
    expect(claudeLapHarness.spawnArgs({ maxBudgetUsd: 10 })).toEqual([
      '-p',
      '--output-format',
      'json',
      '--max-budget-usd',
      '10',
      '--dangerously-skip-permissions',
    ]);
  });

  it('deliverPrompt sends the prompt via stdin', () => {
    expect(claudeLapHarness.deliverPrompt('X')).toEqual({ stdin: 'X' });
  });

  it('parseEnvelope reads a Claude JSON envelope: cost/tokens/result, is_error:false', () => {
    const env = claudeLapHarness.parseEnvelope(
      JSON.stringify({
        result: 'work…\nRALPH-EXIT: {"kind":"SHIPPED","stage":"code"}',
        total_cost_usd: 0.5,
        usage: { input_tokens: 100, output_tokens: 20 },
        is_error: false,
      }),
      '',
    );
    expect(env).toEqual({
      resultText: 'work…\nRALPH-EXIT: {"kind":"SHIPPED","stage":"code"}',
      costUsd: 0.5,
      inputTokens: 100,
      outputTokens: 20,
      isError: false,
    });
    // through the neutral fold → the SHIPPED/stage outcome (proves the extract reaches the same protocol).
    expect(outcomeFromEnvelope(env).outcome).toEqual({ kind: 'SHIPPED', stage: 'code' });
  });

  it('is_error:true → isError (still carrying cost/tokens)', () => {
    const env = claudeLapHarness.parseEnvelope(
      JSON.stringify({
        result: 'boom',
        is_error: true,
        total_cost_usd: 0.02,
        usage: { input_tokens: 50, output_tokens: 10 },
      }),
      '',
    );
    expect(env).toMatchObject({ isError: true, costUsd: 0.02, inputTokens: 50, outputTokens: 10 });
    expect(outcomeFromEnvelope(env).outcome).toEqual({ kind: 'CRASH' });
  });

  it('an unparseable stdout → isError (→ CRASH, never a false SHIPPED)', () => {
    expect(claudeLapHarness.parseEnvelope('not json at all', '').isError).toBe(true);
  });

  it('a non-object JSON envelope → isError', () => {
    expect(claudeLapHarness.parseEnvelope('42', '').isError).toBe(true);
  });

  it('missing total_cost_usd defaults cost to 0; absent/malformed usage → 0 tokens', () => {
    const env = claudeLapHarness.parseEnvelope(
      JSON.stringify({ result: 'ok', is_error: false }),
      '',
    );
    expect(env).toMatchObject({ costUsd: 0, inputTokens: 0, outputTokens: 0 });
    expect(
      claudeLapHarness.parseEnvelope(
        JSON.stringify({ result: 'ok', usage: { input_tokens: 'x' } }),
        '',
      ),
    ).toMatchObject({ inputTokens: 0, outputTokens: 0 });
  });
});
