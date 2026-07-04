/**
 * GR.3 — the UNDROPPABLE lap escalation. When a lap returns HUMAN_REQUIRED (or the supervisor exhausts
 * to UNRECOVERABLE_WEDGE), the orchestrator escalates the typed reason to the human across TWO surfaces:
 *   1. IN-SESSION (always): a clear `🦑 ESCALATION [reason] (item …) — payload` line to the loop's stdout,
 *      printed FIRST, independent of chat — the loop is a subprocess whose stdout is relayed to the human, so
 *      the escalation is SEEN even when chat delivery is down/misconfigured.
 *   2. CHAT (best-effort): the injected transport (`chatEscalator` → the chat-daemon). For a RESIDUAL per-item
 *      escalation a delivery FAILURE is fatal, never swallowed (Inv 6: no silent death); the orchestrator's
 *      parkAndEscalate downgrades a RESOURCE-PAUSE delivery failure to non-fatal (transient clean stop).
 * GR.4 injects the transport adapter so this module stays decoupled + unit-testable.
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
  // ALWAYS surface the escalation IN-SESSION first — independent of chat delivery. The loop is a subprocess
  // whose stdout is relayed to the human, so a clear line here means the escalation is SEEN even when chat is
  // down / misconfigured (the original bug printed only an "unknown platform 'project'" crash). This is the ONE
  // uniform composition site (every reason — BOARD_EMPTY / HUMAN_REQUIRED{…} / BUDGET / UNRECOVERABLE_WEDGE —
  // routes through here via the orchestrator's parkAndEscalate), so ONE print covers them all.
  const itemSuffix = opts.item === undefined ? '' : ` (item ${opts.item})`;
  const payloadSuffix = opts.payload === undefined ? '' : ` — ${JSON.stringify(opts.payload)}`;
  process.stdout.write(`🦑 ESCALATION [${reason}]${itemSuffix}${payloadSuffix}\n`);

  const text = `🦑 HUMAN_REQUIRED(${reason})${opts.item === undefined ? '' : ` [${opts.item}]`}`;
  const res = await opts.escalate({
    reason,
    text,
    ...(opts.item === undefined ? {} : { item: opts.item }),
    ...(opts.payload === undefined ? {} : { payload: opts.payload }),
  });
  if (!res.escalated) throw new EscalationUndeliverableError(reason, res.reason); // never silently drop
}
