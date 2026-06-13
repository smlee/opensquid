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
 * running budget even when a crash-then-ship spent on both attempts.
 *
 * Imported by: src/runtime/ralph/orchestrator.ts (GR.4).
 */
import type { LapOutcome } from './lap_outcome.js';

export type LapResult = LapOutcome & { costUsd: number };

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
  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    opts.heartbeat();
    let out: LapResult | null = null;
    try {
      out = await run();
      costUsd += out.costUsd;
    } catch {
      out = null; // a thrown run is treated as CRASH (retryable)
    }
    if (out !== null && out.kind !== 'CRASH' && out.kind !== 'TIMEOUT') {
      return { ...out, costUsd }; // terminal: SHIPPED / HUMAN_REQUIRED / WEDGE
    }
    if (attempt < opts.maxRetries) await sleep(opts.backoffMs(attempt));
  }
  // bounded → escalate, never silent
  return { kind: 'HUMAN_REQUIRED', reason: 'UNRECOVERABLE_WEDGE', costUsd };
}
