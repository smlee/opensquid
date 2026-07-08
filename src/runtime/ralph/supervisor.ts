/**
 * GR.3 — the lap-supervisor: bounded respawn + observable heartbeat (Inv 6: no silent death, no
 * unbounded retry).
 *
 * `superviseLap` runs a lap, retrying ONLY on CRASH/TIMEOUT (every other outcome — SHIPPED,
 * HUMAN_REQUIRED, WEDGE — is terminal and returned as-is). Retries are BOUNDED by `maxRetries`; on
 * exhaustion it returns a typed `HUMAN_REQUIRED{UNRECOVERABLE_WEDGE}` rather than looping forever or
 * dying quietly. The `heartbeat` callback is the OBSERVABLE liveness tick (the orchestrator passes a
 * lease-refresh, the `live_session_lease` freshness model) — liveness is a signal, not a hope.
 *
 * Cost propagates: each attempt bills `costUsd`, accumulated across retries, so GR.4 can sum the Inv 11
 * running budget even when a crash-then-ship spent on both attempts. Token usage (LSF.5) accumulates the
 * same way — a crashed attempt still burned its input/output tokens, so per-stage metrics stay accurate.
 *
 * Imported by: src/runtime/ralph/orchestrator.ts (GR.4).
 */
import type { LapOutcome } from './lap_outcome.js';

/** A lap's outcome + its accumulated cost + token usage (LSF.5 — tokens fold into loop_metrics). */
export type LapResult = LapOutcome & {
  costUsd: number;
  inputTokens?: number;
  outputTokens?: number;
};

export interface SuperviseOpts {
  maxRetries: number;
  /** Backoff before the n-th retry (n is 0-based attempt index just completed). */
  backoffMs: (attempt: number) => number;
  /** Observable liveness tick, fired once per attempt (e.g. refreshLease). */
  heartbeat: () => void;
  /** Injectable sleep (tests pass a no-op); defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function superviseLap(
  run: () => Promise<LapResult>,
  opts: SuperviseOpts,
): Promise<LapResult> {
  const sleep = opts.sleep ?? realSleep;
  let costUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    opts.heartbeat();
    let out: LapResult | null = null;
    try {
      out = await run();
      costUsd += out.costUsd;
      inputTokens += out.inputTokens ?? 0;
      outputTokens += out.outputTokens ?? 0;
    } catch {
      out = null; // a thrown run is treated as CRASH (retryable)
    }
    if (out !== null && out.kind !== 'CRASH' && out.kind !== 'TIMEOUT') {
      // terminal: SHIPPED / HUMAN_REQUIRED / WEDGE — return the ACCUMULATED cost+tokens (across any retries),
      // overriding this attempt's own per-lap figures so a crash-then-ship bills both attempts' resources.
      return { ...out, costUsd, inputTokens, outputTokens };
    }
    if (attempt < opts.maxRetries) await sleep(opts.backoffMs(attempt));
  }
  // bounded → escalate, never silent
  return {
    kind: 'HUMAN_REQUIRED',
    reason: 'UNRECOVERABLE_WEDGE',
    costUsd,
    inputTokens,
    outputTokens,
  };
}
