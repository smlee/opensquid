/**
 * The typed envelope event bus (T-fsm-actor-runtime §BUS.1) — replaces the
 * single-event `EventEmitter` facade (`agent_bridge/event_bus.ts`).
 *
 * Grounded in gstack `browse/src/activity.ts`: a monotonic seq (`id: nextId++`),
 * a CircularBuffer replay window, `queueMicrotask` notification (never blocks the
 * publish path), and per-subscriber `try/catch` ISOLATION (a throwing subscriber
 * never aborts the publish — the crash-isolation today's bus lacks). `since(seq)`
 * gives cursor replay + gap-detection (gstack `getActivityAfter`).
 *
 * The per-actor mailbox (serialized delivery) is a follow-up (the Akka pattern,
 * not in our proven code yet); this is the pub/sub core gstack proves.
 */
import { CircularBuffer } from './ring.js';
import type { ActorAddr, CorrelationId, Envelope, MessageKind } from './types.js';

interface Sub {
  filter: (e: Envelope) => boolean;
  fn: (e: Envelope) => void;
}

export interface PublishInput<P> {
  from: ActorAddr;
  to: Envelope['to'];
  kind: MessageKind;
  corr?: CorrelationId;
  payload: P;
}

export class Bus {
  private hwm = 0;
  private readonly subs = new Set<Sub>();
  private readonly ring: CircularBuffer<Envelope>;

  constructor(capacity = 4096) {
    this.ring = new CircularBuffer<Envelope>(capacity);
  }

  publish<P>(input: PublishInput<P>): Envelope<P> {
    const full: Envelope<P> = {
      seq: ++this.hwm,
      ts: Date.now(),
      from: input.from,
      to: input.to,
      kind: input.kind,
      payload: input.payload,
      ...(input.corr !== undefined ? { corr: input.corr } : {}),
    };
    this.ring.push(full);
    for (const s of this.subs) {
      if (s.filter(full)) {
        // async + isolated: a slow/throwing subscriber never blocks or aborts the publish path (gstack pattern)
        queueMicrotask(() => {
          try {
            s.fn(full);
          } catch {
            /* subscriber error — don't crash the bus */
          }
        });
      }
    }
    return full;
  }

  subscribe(filter: (e: Envelope) => boolean, fn: (e: Envelope) => void): () => void {
    const sub: Sub = { filter, fn };
    this.subs.add(sub);
    return () => {
      this.subs.delete(sub);
    };
  }

  /** Replay envelopes after `seq`; `gap` ⇒ `seq` fell out of the bounded window (re-sync from a snapshot). */
  since(seq: number): { events: Envelope[]; gap: boolean } {
    return this.ring.since(seq);
  }
}
