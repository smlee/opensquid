/**
 * GR.4 — a chat-daemon-backed `LapEscalator` (the gated-ralph escalation transport).
 *
 * When a lap returns HUMAN_REQUIRED (or the supervisor exhausts to UNRECOVERABLE_WEDGE), the orchestrator
 * escalates the typed reason to the HUMAN. The human is on chat (Telegram), so the real escalation path is
 * the live chat-daemon — the SAME UDS `send` the `chat_send` MCP tool uses. Chosen over `escalateSeverity`
 * for GR.4-first because the critical-tier NotificationRouter has no runtime assembly yet; the
 * escalateSeverity critical-tier is a future enhancement (the escalator is injected, so swapping it is local).
 *
 * The transport (`send`) is INJECTED so this stays unit-testable without a running daemon; the CLI wires
 * the real daemon UDS client. UNDROPPABLE (Inv 6): a delivery failure (or a throw) → `{escalated:false}`,
 * and `escalateLap` (GR.3) then THROWS — the loop never silently drops an escalation.
 *
 * Imports from: ./escalate_lap.js (the LapEscalator contract).
 */
import type { LapEscalator } from './escalate_lap.js';

/** The injected chat transport — the CLI wires this to the chat-daemon UDS `send`. */
export type ChatSend = (params: {
  channel: string;
  text: string;
}) => Promise<{ ok: boolean; reason?: string }>;

/**
 * Build a `LapEscalator` that delivers the lap's typed `text` to `channel` via the injected chat `send`.
 * Never throws (the contract reports delivery via `escalated`); a transport error is reported, not swallowed
 * — `escalateLap` turns a `false` into the undroppable throw.
 */
export function chatEscalator(deps: { send: ChatSend; channel: string }): LapEscalator {
  return async (msg) => {
    try {
      const res = await deps.send({ channel: deps.channel, text: msg.text });
      return res.ok
        ? { escalated: true }
        : { escalated: false, reason: res.reason ?? 'send failed' };
    } catch (e) {
      return { escalated: false, reason: e instanceof Error ? e.message : String(e) };
    }
  };
}
