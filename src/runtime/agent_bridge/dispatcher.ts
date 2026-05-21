/**
 * agent_bridge — event-bus → batch → session → agent-loop glue
 * (WAB.5, 0.5.99).
 *
 * Spec: `docs/tasks/T-warm-agent-chat-bridge.md` WAB.5.
 * Architecture: `docs/tasks/WAB.1-architecture.md` decision (d).
 *
 * Responsibility:
 *   1. Subscribe to `bus.on('inbound')` and forward each event's text
 *      into the per-dispatcher `BatchCoordinator`.
 *   2. Provide the coordinator's `onFlush` handler — get/create the
 *      warm session, call `runAgentTurn` with the coalesced text,
 *      persist via `SessionManager.appendTurn`, forward reply.
 *   3. Enforce the per-session mutex+queue policy closing the
 *      `FIXME(WAB.5)` in session_manager.ts: at most ONE in-flight
 *      turn per session + ONE queued coalesced batch. Subsequent
 *      flushes coalesce into the queue slot up to
 *      MAX_QUEUE_COALESCE_ATTEMPTS; the next attempt DROPS with
 *      `onWarn` so operators can spot flooding.
 *
 * Reply surface: v1 invokes `onReply` (default no-op). WAB.6 wires it
 * to the legacy chat-daemon RPC.
 *
 * Shutdown: idempotent — unsubscribes, shuts down coordinator (drops
 * pending timers), awaits in-flight turns, drops queued batches.
 *
 * Imports from: ./agent_loop.js, ./batch.js, ./event_bus.js,
 *   ./session_manager.js, ./types.js.
 * Imported by: ./index.ts (barrel); future daemon.ts (WAB.7).
 */

import { runAgentTurn, type RunAgentTurnOptions } from './agent_loop.js';
import { BatchCoordinator, type BatchCoordinatorOptions } from './batch.js';
import type { AgentEventBus } from './event_bus.js';
import type { SessionManager } from './session_manager.js';
import type { InboundChatEvent, SessionKey } from './types.js';
import { sessionKeyString } from './types.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Mirror of {@link RunAgentTurnOptions} (no narrowing — keeps
 *  `exactOptionalPropertyTypes` happy when passed through). */
export type DispatcherAgentLoopOptions = RunAgentTurnOptions;

export interface ChatDispatcherOptions {
  bus: AgentEventBus;
  sessionManager: SessionManager;
  /** Agent-loop config shared across all sessions; `dispatcher` here is
   *  the TOOL dispatcher (distinct from this class). */
  agentLoopOptions: DispatcherAgentLoopOptions;
  /** Optional batch-coordinator delay overrides (tests). */
  batchOptions?: Pick<
    BatchCoordinatorOptions,
    'fastDelayMs' | 'shortDelayMs' | 'defaultDelayMs' | 'splitDelayMs'
  >;
  /** Structured warn sink — drop-third-batch + agent-loop failures. */
  onWarn?: (message: string) => void;
  /** Reply hook (WAB.6 wires to chat-daemon RPC). Default no-op. */
  onReply?: (key: SessionKey, replyText: string, projectUuid: string) => void;
  /** Telemetry hook for agent-turn failures. */
  onTurnError?: (key: SessionKey, err: unknown) => void;
}

// ---------------------------------------------------------------------------
// ChatDispatcher
// ---------------------------------------------------------------------------

export class ChatDispatcher {
  private readonly coordinator: BatchCoordinator;
  private readonly inboundListener: (event: InboundChatEvent) => void;
  // pendingQueue: bounded depth = 1; coalesces up to
  // MAX_QUEUE_COALESCE_ATTEMPTS then DROPs. inFlight: shutdown awaits.
  // projectUuidBySlug: bridge across BatchCoordinator's event-boundary
  // coalesce so getOrCreate has the uuid at session creation.
  private readonly pendingQueue = new Map<string, QueuedBatch>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly projectUuidBySlug = new Map<string, string>();
  private readonly warn: (message: string) => void;
  private readonly onReply: (key: SessionKey, replyText: string, projectUuid: string) => void;
  private readonly onTurnError: (key: SessionKey, err: unknown) => void;
  private started = false;
  private stopped = false;

  constructor(private readonly opts: ChatDispatcherOptions) {
    this.warn = opts.onWarn ?? noopWarn;
    this.onReply = opts.onReply ?? noopReply;
    this.onTurnError = opts.onTurnError ?? noopTurnError;
    this.coordinator = new BatchCoordinator({
      ...(opts.batchOptions ?? {}),
      onFlush: (key, coalesced) => this.handleFlush(key, coalesced),
      onError: (key, err) => this.onTurnError(key, err),
    });
    this.inboundListener = (event) => this.handleInbound(event);
  }

  /** Wire the bus listener. Idempotent; throws if called after
   *  shutdown (single-use, matches InboxTransportBridge). */
  start(): void {
    if (this.stopped) throw new Error('ChatDispatcher.start: cannot restart a stopped dispatcher');
    if (this.started) return;
    this.started = true;
    this.opts.bus.on('inbound', this.inboundListener);
  }

  /** Unsubscribe, drop pending, await in-flight. Idempotent. After
   *  shutdown resolves, no further onReply/onTurnError callbacks fire. */
  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.started) {
      this.opts.bus.off('inbound', this.inboundListener);
    }
    this.coordinator.shutdown();
    this.pendingQueue.clear(); // queued batches dropped — never started
    await Promise.allSettled(Array.from(this.inFlight.values()));
    this.inFlight.clear();
    this.projectUuidBySlug.clear();
  }

  get pendingBatchCount(): number {
    return this.coordinator.pendingCount;
  }
  get inFlightTurnCount(): number {
    return this.inFlight.size;
  }
  get queuedTurnCount(): number {
    return this.pendingQueue.size;
  }

  // --- private ---

  private handleInbound(event: InboundChatEvent): void {
    if (this.stopped) return;
    this.projectUuidBySlug.set(sessionKeyString(event.sessionKey), event.projectUuid);
    this.coordinator.ingest(event.sessionKey, event.text);
  }

  /**
   * Coordinator's onFlush — per-session mutex entry point.
   *
   * - No in-flight turn → start one immediately.
   * - In-flight + queue empty → enqueue (depth 1).
   * - In-flight + queue full → coalesce into queue until
   *   MAX_QUEUE_COALESCE_ATTEMPTS, then DROP + warn.
   */
  private async handleFlush(key: SessionKey, coalesced: string): Promise<void> {
    if (this.stopped) return;
    const slug = sessionKeyString(key);
    if (this.inFlight.has(slug)) {
      const queued = this.pendingQueue.get(slug);
      if (queued === undefined) {
        this.pendingQueue.set(slug, { key, text: coalesced, attempts: 1 });
        return;
      }
      if (queued.attempts >= MAX_QUEUE_COALESCE_ATTEMPTS) {
        this.warn(
          `[agent_bridge.dispatcher] dropping batch for session=${slug}: in-flight + queue full ` +
            `(${queued.attempts} prior coalesce attempts; ${coalesced.length} chars dropped)`,
        );
        return;
      }
      queued.text = `${queued.text}\n${coalesced}`;
      queued.attempts += 1;
      return;
    }
    await this.runTurnChain(key, coalesced);
  }

  /**
   * Run an agent turn for `key`, then drain any queued batch. The drain
   * is a recursive tail-call so the in-flight invariant holds across
   * the boundary. Errors surface via `onTurnError`; the in-flight flag
   * clears in `finally` so subsequent flushes proceed after a failure.
   */
  private async runTurnChain(key: SessionKey, text: string): Promise<void> {
    const slug = sessionKeyString(key);
    const promise = this.runTurnOnce(key, text);
    this.inFlight.set(slug, promise);
    try {
      await promise;
    } finally {
      this.inFlight.delete(slug);
    }
    // Drain — if another batch queued while we were running, run it
    // now. We've already exited the in-flight set so the recursive
    // runTurnChain re-enters cleanly.
    const queued = this.pendingQueue.get(slug);
    if (queued !== undefined) {
      this.pendingQueue.delete(slug);
      if (!this.stopped) await this.runTurnChain(queued.key, queued.text);
    }
  }

  private async runTurnOnce(key: SessionKey, text: string): Promise<void> {
    const slug = sessionKeyString(key);
    let state;
    try {
      // projectUuid: slug-map (populated in handleInbound) first; fall
      // back to live state for pre-created sessions.
      const projectUuid =
        this.projectUuidBySlug.get(slug) ?? this.opts.sessionManager.peek(key)?.projectUuid ?? '';
      state = await this.opts.sessionManager.getOrCreate(key, projectUuid);
    } catch (err) {
      this.warn(`[agent_bridge.dispatcher] getOrCreate failed ${slug}: ${describeErr(err)}`);
      this.onTurnError(key, err);
      return;
    }
    this.opts.sessionManager.beginTurn(key);
    try {
      const result = await runAgentTurn(state, text, this.opts.agentLoopOptions);
      await this.opts.sessionManager.appendTurn(key, result.assistantEntries);
      this.onReply(key, result.replyText, state.projectUuid);
    } catch (err) {
      // Clear turnInFlight by hand — appendTurn would normally do it.
      const live = this.opts.sessionManager.peek(key);
      if (live !== undefined) live.turnInFlight = false;
      this.warn(`[agent_bridge.dispatcher] turn failed ${slug}: ${describeErr(err)}`);
      this.onTurnError(key, err);
    }
  }
}

function describeErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Constants + helpers
// ---------------------------------------------------------------------------

/** Queue coalesce cap. WAB.5 spec: "Third arrival while in-flight +
 *  queued → DROP." Attempt 1 fills the slot, 2 coalesces, 3 drops. */
const MAX_QUEUE_COALESCE_ATTEMPTS = 2;

interface QueuedBatch {
  key: SessionKey;
  text: string;
  attempts: number;
}

const noop = (): void => {
  /* default sink */
};
const noopWarn: (msg: string) => void = noop;
const noopReply: (k: SessionKey, r: string, p: string) => void = noop;
const noopTurnError: (k: SessionKey, e: unknown) => void = noop;
