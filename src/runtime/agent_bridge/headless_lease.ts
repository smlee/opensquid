/**
 * agent_bridge — headless lease handoff (T-CHAT-AS-TERMINAL CAT.5).
 *
 * North star (invariant #7): when an umbrella has NO live human session, the
 * always-on agent-bridge daemon runs HEADLESS — it holds the umbrella's chat
 * lease, resumes the SAME session, and answers chat. When a human session's
 * lease appears, the headless daemon STANDS DOWN (stops answering) but the
 * process stays alive; when the human lease goes stale again, the daemon
 * RE-ACQUIRES. Exactly one chat-answering session per umbrella → no
 * double-answer / 409.
 *
 * State machine (one umbrella):
 *
 *        ┌─────────────── acquire ────────────────┐
 *        │  (no fresh lease, or the fresh lease    │
 *        │   is already OUR headless id)           │
 *        ▼                                          │
 *   ┌─────────┐   human lease appears (fresh,     ┌─────────────┐
 *   │  HELD   │── owned by someone else) ───────▶ │  STOOD-DOWN  │
 *   │ (ours)  │                                   │ (not ours)   │
 *   └─────────┘ ◀── that lease goes STALE ─────── └─────────────┘
 *        │ heartbeat (30s, fs touch) while HELD        │ reclaimCheck (60s) re-attempts acquire
 *        ▼                                              ▼ when the foreign lease lapses
 *
 * ZERO IDLE TOKEN COST: the heartbeat is a pure `refreshLease` (one fs write).
 * There is NO keep-warm / ping loop here and none anywhere in the bridge — the
 * only model call happens on a real inbound (the dispatcher), never on the
 * heartbeat/reclaim ticks. The process simply parks between turns.
 *
 * Holder identity: the headless session id is `headless-<umbrellaId>` — stable
 * across the daemon's lifetime so (a) the lease's `session_id` reliably tells
 * "ours vs theirs" for the double-holder guard, and (b) subscription resume
 * (`--resume headless-<umbrellaId>`) always threads the SAME claude session.
 *
 * Imports from: node:timers, ../chat/live_session_lease, ../paths.
 * Imported by: ./daemon.ts (wires acquire + start on daemon start, stop on
 *   shutdown), tests.
 */

import {
  isLeaseFresh,
  isLeaseFreshAndOwnedBy,
  readLease,
  refreshLease,
  removeLease,
  writeLease,
} from '../chat/live_session_lease.js';
import { umbrellaLiveSessionLease } from '../paths.js';

/** Heartbeat cadence — refresh OUR lease so a live `chat watch` never sees us
 *  as stale. Matches the chat-watch HEARTBEAT_MS (well under STALE_MS=90s). */
export const HEADLESS_HEARTBEAT_MS = 30_000;

/** Reclaim cadence — re-check whether a foreign lease has gone stale so we can
 *  re-acquire. Folded into the same ticker as the heartbeat for simplicity. */
export const HEADLESS_RECLAIM_MS = 60_000;

/** Stable headless holder id for an umbrella. */
export function headlessSessionId(umbrellaId: string): string {
  return `headless-${umbrellaId}`;
}

export interface HeadlessLeaseManagerOptions {
  umbrellaId: string;
  /** Injected timers (tests). Default node setInterval/clearInterval. */
  setIntervalFn?: (handler: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (handle: ReturnType<typeof setInterval>) => void;
  /** Injected clock (tests). Default `() => new Date()`. */
  now?: () => Date;
  /** Heartbeat/reclaim cadence override (tests). Default HEADLESS_HEARTBEAT_MS. */
  tickMs?: number;
  /** Structured warn sink for lease-io failures. Default no-op. */
  onWarn?: (message: string) => void;
}

/**
 * Owns the headless lease lifecycle for ONE umbrella. The daemon constructs
 * one, `start()`s it (acquire-if-free + begin the heartbeat ticker), and
 * `stop()`s it on shutdown (release our hold + stop the ticker). The dispatcher
 * reads the SAME lease file (ownership-aware) at flush time — this manager
 * never gates the dispatcher directly; it only keeps the on-disk lease correct.
 */
export class HeadlessLeaseManager {
  private readonly umbrellaId: string;
  private readonly leasePath: string;
  private readonly sessionId: string;
  private readonly setIntervalFn: (
    handler: () => void,
    ms: number,
  ) => ReturnType<typeof setInterval>;
  private readonly clearIntervalFn: (handle: ReturnType<typeof setInterval>) => void;
  private readonly now: () => Date;
  private readonly tickMs: number;
  private readonly warn: (message: string) => void;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** True while WE currently hold the lease (our id, fresh). Drives whether
   *  the heartbeat refreshes (HELD) vs. the reclaim re-attempts (STOOD-DOWN). */
  private held = false;
  private stopped = false;

  constructor(opts: HeadlessLeaseManagerOptions) {
    this.umbrellaId = opts.umbrellaId;
    this.leasePath = umbrellaLiveSessionLease(opts.umbrellaId);
    this.sessionId = headlessSessionId(opts.umbrellaId);
    this.setIntervalFn = opts.setIntervalFn ?? ((h, ms) => setInterval(h, ms));
    this.clearIntervalFn = opts.clearIntervalFn ?? ((t) => clearInterval(t));
    this.now = opts.now ?? ((): Date => new Date());
    this.tickMs = opts.tickMs ?? HEADLESS_HEARTBEAT_MS;
    this.warn = opts.onWarn ?? noop;
  }

  /** This daemon's stable headless session id (`headless-<umbrellaId>`). */
  get headlessId(): string {
    return this.sessionId;
  }

  /** True iff we currently hold the lease. */
  get isHolding(): boolean {
    return this.held;
  }

  /**
   * Try to acquire the lease IFF it is free for us. Returns true ⇒ we now hold
   * (the on-disk lease carries our headless id). Returns false ⇒ a DIFFERENT
   * fresh lease exists (human or other) → we stand down.
   *
   *   - no fresh lease (absent / stale)                → writeLease(ours) + true
   *   - fresh lease ALREADY ours (idempotent re-acq)   → refresh + true
   *   - fresh lease owned by someone else              → false (stand down)
   */
  async acquireIfFree(): Promise<boolean> {
    const now = this.now();
    const lease = await readLease(this.leasePath);
    if (lease !== null && isLeaseFresh(lease, now) && lease.session_id !== this.sessionId) {
      // Someone else holds a fresh lease — stand down.
      this.held = false;
      return false;
    }
    // Free (absent/stale) OR already ours → (re)write our lease.
    try {
      await writeLease(this.leasePath, this.sessionId, now);
      this.held = true;
      return true;
    } catch (err) {
      this.warn(
        `[agent_bridge.headless_lease] acquire failed (${this.umbrellaId}): ${describe(err)}`,
      );
      this.held = false;
      return false;
    }
  }

  /**
   * One heartbeat+reclaim tick. fs-only — NO model/SDK call.
   *   - HELD (our lease still fresh + ours)        → refresh the timestamp.
   *   - HELD but the lease flipped to someone else → stand down (stop holding).
   *   - NOT held + the foreign lease is now stale  → re-acquire.
   *   - NOT held + a fresh foreign lease remains   → stay stood-down.
   */
  async tick(): Promise<void> {
    if (this.stopped) return;
    const now = this.now();
    const lease = await readLease(this.leasePath);
    if (this.held) {
      if (isLeaseFreshAndOwnedBy(lease, this.sessionId, now)) {
        // Still ours → keep it warm (single fs write).
        try {
          await refreshLease(this.leasePath, now);
        } catch (err) {
          this.warn(
            `[agent_bridge.headless_lease] heartbeat failed (${this.umbrellaId}): ${describe(err)}`,
          );
        }
        return;
      }
      // A human (or other) took the lease while we held it → stand down.
      this.held = false;
      return;
    }
    // Not holding → re-acquire only if the lease is free (absent/stale/ours).
    await this.acquireIfFree();
  }

  /** Acquire-if-free, then start the heartbeat/reclaim ticker. Idempotent. */
  async start(): Promise<void> {
    if (this.stopped) throw new Error('HeadlessLeaseManager.start: cannot restart after stop');
    if (this.timer !== null) return;
    await this.acquireIfFree();
    this.timer = this.setIntervalFn(() => {
      void this.tick();
    }, this.tickMs);
    // Don't keep the event loop alive solely for the heartbeat — the daemon's
    // transport watcher is the process's anchor.
    (this.timer as { unref?: () => void }).unref?.();
  }

  /**
   * Stop the ticker and RELEASE our hold (best-effort) so a freshly-opened
   * terminal isn't blocked by a stale headless lease on clean shutdown. We
   * only remove the lease if it is still OURS — never clobber a human's lease.
   * Idempotent.
   */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer !== null) {
      this.clearIntervalFn(this.timer);
      this.timer = null;
    }
    const lease = await readLease(this.leasePath);
    if (lease !== null && lease.session_id === this.sessionId) {
      await removeLease(this.leasePath);
    }
    this.held = false;
  }
}

const noop = (): void => {
  /* default sink */
};

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
