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

const LIVE = process.env.OPENSQUID_CODEX_LIVE === '1';

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
