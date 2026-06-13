/**
 * GR.3 — the UNDROPPABLE lap escalation. When a lap returns HUMAN_REQUIRED (or the supervisor exhausts
 * to UNRECOVERABLE_WEDGE), the orchestrator escalates the typed reason to the human — and a delivery
 * FAILURE is fatal, never swallowed (Inv 6: no silent death). The actual transport is the existing
 * critical-tier path (`escalateSeverity` → NotificationRouter multicast); GR.4 injects an adapter so
 * this module stays decoupled from the notification stack and unit-testable.
 *
 * Imported by: src/runtime/ralph/orchestrator.ts (GR.4).
 */
import type { HumanRequiredReason } from './lap_outcome.js';

/** The injected transport. GR.4 wires this to `escalateSeverity` with the user's routing + router. */
export type LapEscalator = (msg: {
  reason: HumanRequiredReason;
  item?: string;
  payload?: unknown;
  text: string;
}) => Promise<{ escalated: boolean; reason?: string }>;

export class EscalationUndeliverableError extends Error {
  constructor(
    public readonly humanRequiredReason: HumanRequiredReason,
    public readonly fallthrough: string | undefined,
  ) {
    super(
      `gated-ralph escalation UNDELIVERABLE for ${humanRequiredReason}: ${fallthrough ?? 'no channel'}`,
    );
    this.name = 'EscalationUndeliverableError';
  }
}

export async function escalateLap(
  reason: HumanRequiredReason,
  opts: { item?: string; payload?: unknown; escalate: LapEscalator },
): Promise<void> {
  const text = `🦑 HUMAN_REQUIRED(${reason})${opts.item === undefined ? '' : ` [${opts.item}]`}`;
  const res = await opts.escalate({
    reason,
    text,
    ...(opts.item === undefined ? {} : { item: opts.item }),
    ...(opts.payload === undefined ? {} : { payload: opts.payload }),
  });
  if (!res.escalated) throw new EscalationUndeliverableError(reason, res.reason); // never silently drop
}
