/**
 * RSW.2 — user notification for the retention sweep (Task #16 / wg-9e4f4eb2a40f).
 *
 * When the RSW.1 sweep hard-deletes retired agent memories at session-end,
 * the user sees only a `process.stderr` line — invisible in a normal Claude
 * Code session where the terminal is not open.
 * This module sends a chat notification via the same daemon-send path as
 * `stop_stream.ts` (the canonical hook-initiated send pattern).
 *
 * Pattern: loadChannelsConfig → resolveUmbrellaForCwd → resolveOutbound →
 * gate on pingDaemon() → sendChat. Fail-open: every error path is a no-op;
 * `session-end.ts` wraps the call in try/catch and keeps the stderr line as
 * the unconditional fallback.
 *
 * Imports from: ../../channels/routing, ../../chat_daemon/client.
 * Imported by: session-end.ts + session_end_sweep_notify.test.ts.
 */

import {
  loadChannelsConfig,
  resolveOutbound,
  resolveUmbrellaForCwd,
} from '../../channels/routing.js';
import { pingDaemon, sendChat } from '../../chat_daemon/client.js';
import type { DaemonSendParams, DaemonSendResult } from '../../chat_daemon/client.js';

export type PingFn = (timeoutMs?: number) => Promise<boolean>;
export type SendFn = (params: DaemonSendParams) => Promise<DaemonSendResult>;

/**
 * If `swept.length > 0` and the chat daemon is reachable, send a retention-
 * sweep notification to the umbrella's outbound Telegram target for `cwd`.
 *
 * No-ops (returns without throwing) when:
 *   - the sweep was empty (`swept.length === 0`)
 *   - the daemon is absent (`ping()` → false)
 *   - no channels config on disk / no umbrella bound to `cwd` / no outbound target
 *
 * All errors propagate to the caller; `session-end.ts` wraps in try/catch.
 */
export async function notifyRetentionSweep(
  swept: readonly unknown[],
  cwd: string,
  send: SendFn = sendChat,
  ping: PingFn = pingDaemon,
): Promise<void> {
  if (swept.length === 0) return;
  if (!(await ping())) return;

  const cfg = await loadChannelsConfig().catch(() => null);
  if (cfg === null) return;

  const umbrellaId = resolveUmbrellaForCwd(cfg, cwd);
  if (umbrellaId === null) return;

  const tg = resolveOutbound(cfg, umbrellaId);
  if (tg === null) return;

  await send({
    channel: `telegram:${tg.chat_id}`,
    text: `opensquid: memory retention sweep — ${swept.length} retired agent memories hard-deleted after 30 quiet days.`,
    ...(tg.topic_id !== undefined ? { threadId: String(tg.topic_id) } : {}),
  });
}
