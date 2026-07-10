/**
 * FCE.4 (§3 binding acceptance) — a REAL Codex refusal must NOT close the item.
 *
 * This is the end-to-end fail-closed acceptance: a recorded `codex exec --json` refusal stream (≥1
 * agent_message, NO `turn.completed`) is driven through the REAL `codexLapHarness.parseEnvelope` → REAL
 * `outcomeFromEnvelope` (no mock of the fold) and must resolve to a NON-SHIPPED outcome — specifically CRASH,
 * which the supervisor retries to a bounded `HUMAN_REQUIRED{UNRECOVERABLE_WEDGE}` park. Only a SHIPPED outcome
 * ever closes a work-graph item (the orchestrator maps SHIPPED→close, every other outcome→parkAndEscalate,
 * orchestrator.ts:554-567), so proving the outcome is never SHIPPED is proving the item is never closed.
 *
 * Fixture provenance: a hand-written stream in the LIVE-confirmed codex-cli 0.144.0 event shape (item.completed
 * / agent_message, no turn.completed) — functionally equivalent to a captured real refusal (a genuine Codex
 * refusal emits the message but never completes the turn) and deterministic in CI, which a live `codex` spawn
 * is not. No real binary is spawned here.
 */
import { describe, expect, it } from 'vitest';

import { codexLapHarness } from './harnesses/codex_lap_harness.js';
import { outcomeFromEnvelope } from './lap_outcome.js';
import { superviseLap } from './supervisor.js';

/** A recorded-shape Codex REFUSAL stream: the model emitted a refusal message and NEVER completed the turn. */
const CODEX_REFUSAL_STREAM = [
  JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
  JSON.stringify({ type: 'turn.started' }),
  JSON.stringify({
    type: 'item.completed',
    item: { id: 'item_0', type: 'agent_message', text: "I'm sorry, but I can't help with that." },
  }),
  // NOTE: NO `turn.completed` — the refusal aborted the turn.
].join('\n');

describe('FCE.4 LIVE — a real Codex refusal never closes the item (real adapter + real fold)', () => {
  it('the recorded refusal → real parseEnvelope → real fold ⇒ CRASH (non-SHIPPED)', () => {
    const env = codexLapHarness.parseEnvelope(CODEX_REFUSAL_STREAM, '');
    expect(env.isError).toBe(true); // FCE.2: no turn.completed ⇒ errored stream
    const { outcome } = outcomeFromEnvelope(env); // FCE.1: real fail-closed fold, NOT a mock
    expect(outcome).toEqual({ kind: 'CRASH' });
    expect(outcome.kind).not.toBe('SHIPPED'); // the binding: a refusal is never SHIPPED
  });

  it('through the real supervisor the refusal exhausts CRASH-retries to an UNRECOVERABLE_WEDGE park (never SHIPPED)', async () => {
    // Drive the whole retry chain: each attempt re-parses the SAME recorded refusal (deterministic → always
    // CRASH), so the supervisor bounds it to a HUMAN_REQUIRED park — never a SHIPPED that would close the item.
    let attempts = 0;
    const result = await superviseLap(
      () => {
        attempts++;
        const env = codexLapHarness.parseEnvelope(CODEX_REFUSAL_STREAM, '');
        const { outcome, costUsd, inputTokens, outputTokens } = outcomeFromEnvelope(env);
        return Promise.resolve({ ...outcome, costUsd, inputTokens, outputTokens });
      },
      {
        maxRetries: 2,
        backoffMs: () => 0,
        heartbeat: () => undefined,
        sleep: () => Promise.resolve(),
      },
    );
    expect(result.kind).toBe('HUMAN_REQUIRED');
    expect(result.kind).not.toBe('SHIPPED');
    if (result.kind === 'HUMAN_REQUIRED') expect(result.reason).toBe('UNRECOVERABLE_WEDGE');
    expect(attempts).toBe(3); // initial + 2 bounded retries, then park — never an infinite spin
  });
});
