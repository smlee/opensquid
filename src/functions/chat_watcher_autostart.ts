/**
 * chat_watcher_autostart (T-CHAT-REALTIME) — make SessionStart actually SET UP
 * chat, instead of only claiming the lease.
 *
 * The gap: SessionStart's only chat action was `claimUmbrellaLeaseForSession`.
 * It never started the inbound watcher, so a fresh/restarted session received
 * Telegram messages ONLY at a turn boundary (the Stop-hook drive) — an idle
 * session never got them, and a restart "did nothing" for chat. This primitive,
 * dispatched on `session_start`, returns an `inject_context` directive telling
 * the agent to start the real-time inbound watcher (`opensquid chat watch` under
 * the `Monitor` tool) IF the umbrella has a chat channel configured. The watcher
 * streams each inbound message to the agent the instant it lands (OS file-events,
 * push — not a busy-poll), so an idle session wakes and replies in real time,
 * with NO `--channels` dev flag.
 *
 * Only the AGENT can call `Monitor`, so a hook can only DIRECT it — this is that
 * directive. Gated on a resolvable umbrella + a configured telegram channel so it
 * is silent for sessions with no chat. Fail-open: any error → null (a health
 * primitive must never block a session begin).
 *
 * Imports from: zod, ../runtime/result.js, ../channels/routing.js.
 * Imported by: src/runtime/bootstrap.ts (registry wiring).
 */

import { z } from 'zod';

import { loadChannelsConfig, resolveUmbrellaForCwd } from '../channels/routing.js';
import { ok } from '../runtime/result.js';

import type { FunctionDef } from './registry.js';

const NoArgs = z.object({}).strict();

interface AutostartResult {
  kind: 'inject_context';
  content: string;
}

export const ChatWatcherAutostart: FunctionDef<z.input<typeof NoArgs>, AutostartResult | null> = {
  name: 'chat_watcher_autostart',
  argSchema: NoArgs,
  durable: false,
  memoizable: false,
  costEstimateMs: 3,
  execute: async (_args, ctx) => {
    try {
      const cwd =
        ctx.event.kind === 'session_start' ? (ctx.event.cwd ?? process.cwd()) : process.cwd();
      const cfg = await loadChannelsConfig().catch(() => null);
      if (cfg === null) return ok(null);
      const umbrellaId = resolveUmbrellaForCwd(cfg, cwd);
      if (umbrellaId === null || umbrellaId === '') return ok(null);
      const umb = cfg.umbrellas.find((u) => u.id === umbrellaId);
      if (umb?.telegram === undefined) return ok(null); // no chat channel → nothing to watch

      const content =
        `📡 CHAT SETUP — start the inbound watcher now so this session receives Telegram ` +
        `messages in REAL TIME (push, no turn-boundary wait). If a "chat watch" Monitor is not ` +
        `already running for this session, call: ` +
        `Monitor({ command: "opensquid chat watch", persistent: true, description: "live inbound telegram" }). ` +
        `Each streamed line is an inbound message — reply on the channel via chat_send (it threads to ` +
        `the right topic). This is the no-flag real-time path; do it once per session.`;
      return ok({ kind: 'inject_context' as const, content });
    } catch {
      return ok(null);
    }
  },
};
