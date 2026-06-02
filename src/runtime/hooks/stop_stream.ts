/**
 * CAT.3 — stream a chat-driven turn's OUTPUT back to its source topic.
 *
 * The symmetric half of CAT.2's drive. When CAT.2 drives a turn from an inbound
 * chat message it leaves a marker (`markChatDriven`); when that turn completes,
 * the Stop hook calls `maybeStreamOutput`, which — if the marker matches THIS
 * session — sends the assistant's final text to the umbrella's outbound Telegram
 * target (`resolveOutbound`, reply-to-source — the agent never picks the
 * channel) and consumes the marker. Terminal-driven turns leave no marker, so
 * they don't stream (chat-IN → chat-OUT; terminal-IN stays terminal — no flood).
 *
 * Outbound goes through the SAME daemon `send` RPC as `chat_send`
 * (`defaultDaemonSend`), so it honors the one transport + the border invariant.
 * Fail-open: any error / no umbrella / no marker / empty text → no send.
 *
 * Imports from: node:fs/promises, ../../channels/routing, ../paths,
 *   ../agent_bridge/tools/chat_send (the daemon-send seam).
 * Imported by: src/runtime/hooks/{stop,stop_drive}.ts + tests.
 */

import { readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  loadChannelsConfig,
  resolveOutbound,
  resolveUmbrellaForCwd,
} from '../../channels/routing.js';
import type { DaemonSendFn } from '../agent_bridge/tools/chat_send.js';
import { defaultDaemonSend } from '../agent_bridge/tools/chat_send.js';
import { umbrellaChatDrivenMarker } from '../paths.js';

/**
 * Mark that the lease-holding `sessionId` just had a turn DRIVEN from chat for
 * `umbrellaId`; the next Stop will stream that turn's output back. Best-effort.
 */
export async function markChatDriven(umbrellaId: string, sessionId: string): Promise<void> {
  const path = umbrellaChatDrivenMarker(umbrellaId);
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, sessionId, 'utf8');
  } catch {
    // best-effort — a missed marker just means that turn's output isn't mirrored.
  }
}

/**
 * If this session's just-completed turn was chat-driven, stream `assistantText`
 * to the umbrella's source topic and consume the marker. Returns true iff it
 * sent. `send` is injectable for tests (defaults to the daemon RPC).
 */
export async function maybeStreamOutput(
  sessionId: string,
  cwd: string,
  assistantText: string,
  send: DaemonSendFn = defaultDaemonSend,
): Promise<boolean> {
  try {
    if (assistantText.trim() === '') return false;
    const cfg = await loadChannelsConfig().catch(() => null);
    const umbrellaId = cfg === null ? null : resolveUmbrellaForCwd(cfg, cwd);
    if (umbrellaId === null || umbrellaId === '') return false;

    const markerPath = umbrellaChatDrivenMarker(umbrellaId);
    const marker = await readFile(markerPath, 'utf8').catch(() => null);
    // Only the session that drove the turn streams its output (lease holder).
    if (marker?.trim() !== sessionId) return false;

    const tg = resolveOutbound(cfg!, umbrellaId);
    if (tg === null) {
      await rm(markerPath, { force: true }); // no target — drop the marker
      return false;
    }

    await send({
      channel: `telegram:${tg.chat_id}`,
      text: assistantText,
      ...(tg.topic_id !== undefined ? { threadId: String(tg.topic_id) } : {}),
    });
    await rm(markerPath, { force: true }); // consume
    return true;
  } catch {
    return false;
  }
}
