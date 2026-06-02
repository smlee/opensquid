/**
 * `check_chat_connection` primitive (T-HANDOFF-HARDENING HH6.2; re-keyed to
 * UMBRELLA in T-CHAT-AS-TERMINAL CAT.1c).
 *
 * The first consumer of the SessionStart hook mechanism (HH6.1). On a
 * `session_start` event it reports the session's chat-connection state as a
 * `RuleResult.inject_context` payload (the SessionStart hook bin surfaces it
 * via `hookSpecificOutput.additionalContext`):
 *
 *   - the cwd resolves to an umbrella with a telegram binding (+ bot token) →
 *     report the topic + whether a `chat watch` live-session lease is held;
 *   - else another configured platform (slack/discord) → report that;
 *   - else → nudge to run `opensquid setup` (or set the opt-out).
 *
 * CAT.1c collapsed the legacy per-project drift check: the umbrella is now
 * STRUCTURAL (one row in `channels.json` owns every member cwd + the single
 * `(chat_id, topic_id)`), so routing drift between members is impossible by
 * construction — `detectUmbrellaDrift` is DELETED. Routing is read from the
 * single authoritative `channels.json` via `loadChannelsConfig`, never from
 * per-project `chat-routing.json` (which CAT.1d retires).
 *
 * REPORT-ONLY, per [[project_opensquid_no_agent_loop]]: this primitive reads
 * state and composes a message; it never starts `chat watch`, spawns a daemon,
 * or repairs routing. The agent reads the surfaced report and acts.
 *
 * Opt-out (HH6.2 L7): `chat.session_start_check: "off"` in
 * `~/.opensquid/config.json` → returns `ok(null)` (no injection).
 *
 * v1 deliberately does NOT make a live Telegram `getChat` reachability call:
 * a network hang must never delay session start, so "configured" is read from
 * routing + token presence (fail-fast, config-only).
 *
 * Fail-quiet: every fs read is ENOENT-tolerant and any unexpected error
 * returns `ok(null)` — a connection check must never break session start.
 * `channels.json` may not exist yet (synthesized at the CAT.1d cutover); an
 * absent config / unresolved umbrella degrades to the "no chat wired" nudge.
 *
 * Special evaluator integration (same as `recall_pre_inject`): returning
 * `{ kind: 'inject_context', content }` makes the evaluator treat it as a
 * TERMINAL RuleResult; `null` is the empty/no-verdict branch.
 *
 * Imports from: zod, node:fs/promises, node:path, ../channels/routing.js,
 *   ../runtime/result.js, ../runtime/paths.js,
 *   ../runtime/chat/live_session_lease.js.
 * Imported by: src/runtime/bootstrap.ts (registry wiring).
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { loadChannelsConfig, resolveOutbound, resolveUmbrellaForCwd } from '../channels/routing.js';
import { isLeaseFresh, readLease } from '../runtime/chat/live_session_lease.js';
import { OPENSQUID_HOME, umbrellaLiveSessionLease } from '../runtime/paths.js';
import { ok } from '../runtime/result.js';

import type { FunctionRegistry } from './registry.js';

// `cwd` is an optional override (tests inject it); production reads it from
// the session_start event payload via ctx.
const CheckChatConnectionArgs = z.object({ cwd: z.string().optional() }).strict();

interface OpensquidConfig {
  chat?: { session_start_check?: string };
  chat_connections?: {
    telegram?: { bot_token?: string };
    slack?: unknown;
    discord?: unknown;
  };
}

/** ENOENT/parse-tolerant JSON read — absent or malformed ⇒ null. */
async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function registerCheckChatConnectionFunction(registry: FunctionRegistry): void {
  registry.register({
    name: 'check_chat_connection',
    argSchema: CheckChatConnectionArgs,
    durable: false,
    memoizable: false,
    costEstimateMs: 30,
    execute: async (args, ctx) => {
      try {
        const config =
          (await readJsonFile<OpensquidConfig>(join(OPENSQUID_HOME(), 'config.json'))) ?? {};
        // L7 opt-out — explicit field only; declined ≠ never-set-up.
        if (config.chat?.session_start_check === 'off') return ok(null);

        const cwd =
          args.cwd ??
          (ctx.event.kind === 'session_start' ? ctx.event.cwd : undefined) ??
          process.cwd();

        // CAT.1c: resolve the session's umbrella from channels.json (the single
        // authoritative routing source). Absent config / unresolved cwd → no
        // umbrella; degrades to the "no chat wired" nudge below.
        const channels = await loadChannelsConfig();
        const umbrellaId = channels === null ? null : resolveUmbrellaForCwd(channels, cwd);

        const parts: string[] = [];
        const tokenPresent =
          typeof config.chat_connections?.telegram?.bot_token === 'string' &&
          config.chat_connections.telegram.bot_token.length > 0;

        if (umbrellaId !== null && channels !== null) {
          const tg = resolveOutbound(channels, umbrellaId);
          if (tg !== null && tokenPresent) {
            const held = isLeaseFresh(await readLease(umbrellaLiveSessionLease(umbrellaId)));
            const topic = tg.topic_id !== undefined ? ` topic ${String(tg.topic_id)}` : '';
            parts.push(
              held
                ? `✅ Chat: telegram${topic} configured (umbrella ${umbrellaId}); \`chat watch\` lease held (this session receives inbound).`
                : `🔌 Chat: telegram${topic} configured (umbrella ${umbrellaId}), but \`chat watch\` is NOT running — start it (Monitor: \`opensquid chat watch\`) so inbound reaches this session.`,
            );
          } else if (
            config.chat_connections?.slack !== undefined ||
            config.chat_connections?.discord !== undefined
          ) {
            parts.push(
              `🔌 Chat: a non-telegram platform is configured but telegram isn't wired for ` +
                `umbrella ${umbrellaId}. Run \`opensquid setup\` to wire it.`,
            );
          } else {
            parts.push(
              `🔌 No chat connection wired for umbrella ${umbrellaId}. Run \`opensquid setup\` to ` +
                `connect Telegram/Slack/Discord, or set \`chat.session_start_check: "off"\` in ` +
                `~/.opensquid/config.json to silence this.`,
            );
          }
        } else {
          parts.push(
            `🔌 No chat connection wired (umbrella not resolved for this cwd). Run ` +
              `\`opensquid setup\`, or set \`chat.session_start_check: "off"\` to silence.`,
          );
        }

        const content = parts.join('\n');
        return ok(content.length > 0 ? { kind: 'inject_context' as const, content } : null);
      } catch {
        // Fail-quiet: a connection check must never break session start.
        return ok(null);
      }
    },
  });
}
