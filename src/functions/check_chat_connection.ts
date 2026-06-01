/**
 * `check_chat_connection` primitive (T-HANDOFF-HARDENING HH6.2).
 *
 * The first consumer of the SessionStart hook mechanism (HH6.1). On a
 * `session_start` event it reports the project's chat-connection state as a
 * `RuleResult.inject_context` payload (the SessionStart hook bin surfaces it
 * via `hookSpecificOutput.additionalContext`):
 *
 *   - telegram configured (routing + bot token) → report topic + whether a
 *     `chat watch` live-session lease is currently held;
 *   - else another configured platform (slack/discord) → report that;
 *   - else → nudge to run `opensquid setup` (or set the opt-out).
 *
 * It ALSO performs a GENERIC umbrella-routing-drift check: projects that share
 * one report destination (channel + topic) form an "umbrella" and should carry
 * consistent inbound routing; if their inbound config has drifted, the report
 * flags it. No hardcoded project UUIDs — the umbrella is derived from whatever
 * shares a destination, so it ships safely in the builtin pack.
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
 *
 * Special evaluator integration (same as `recall_pre_inject`): returning
 * `{ kind: 'inject_context', content }` makes the evaluator treat it as a
 * TERMINAL RuleResult; `null` is the empty/no-verdict branch.
 *
 * Imports from: zod, node:fs/promises, node:path, ../runtime/result.js,
 *   ../runtime/paths.js, ../runtime/chat/live_session_lease.js.
 * Imported by: src/runtime/bootstrap.ts (registry wiring).
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { isLeaseFresh, readLease } from '../runtime/chat/live_session_lease.js';
import { OPENSQUID_HOME, resolveProjectUuid } from '../runtime/paths.js';
import { ok } from '../runtime/result.js';

import type { FunctionRegistry } from './registry.js';

// `cwd` is an optional override (tests inject it); production reads it from
// the session_start event payload via ctx.
const CheckChatConnectionArgs = z.object({ cwd: z.string().optional() }).strict();

interface TelegramRouting {
  report_channel?: string;
  report_topic_id?: number;
  inbound_chat_ids?: string[];
  inbound_topic_ids?: number[];
}
interface ChatRouting {
  telegram?: TelegramRouting;
  slack?: unknown;
  discord?: unknown;
}
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

const routingPath = (uuid: string): string =>
  join(OPENSQUID_HOME(), 'projects', uuid, 'chat-routing.json');

/**
 * Generic umbrella-drift detector. Groups every project's telegram routing by
 * its destination (`report_channel` + `report_topic_id`); a group with >1
 * member is an "umbrella" that should carry consistent inbound config. If the
 * members' `(inbound_chat_ids, inbound_topic_ids)` differ, the umbrella has
 * drifted (e.g. one project's routing file lost its inbound fields). No
 * hardcoded UUIDs — works for any user's project layout. Returns a warning
 * line or null. Fail-quiet.
 */
async function detectUmbrellaDrift(): Promise<string | null> {
  let uuids: string[];
  try {
    uuids = await readdir(join(OPENSQUID_HOME(), 'projects'));
  } catch {
    return null;
  }
  const groups = new Map<string, { uuid: string; inbound: string }[]>();
  for (const uuid of uuids) {
    const routing = await readJsonFile<ChatRouting>(routingPath(uuid));
    const tg = routing?.telegram;
    if (tg?.report_channel === undefined) continue;
    const destKey = `${tg.report_channel}:${tg.report_topic_id ?? ''}`;
    const inboundKey = JSON.stringify({
      c: tg.inbound_chat_ids ?? null,
      t: tg.inbound_topic_ids ?? null,
    });
    const arr = groups.get(destKey) ?? [];
    arr.push({ uuid, inbound: inboundKey });
    groups.set(destKey, arr);
  }
  const drifted: string[] = [];
  for (const [dest, members] of groups) {
    if (members.length < 2) continue;
    if (new Set(members.map((m) => m.inbound)).size > 1) {
      drifted.push(`${dest} (${members.map((m) => m.uuid.slice(0, 8)).join(', ')})`);
    }
  }
  if (drifted.length === 0) return null;
  return (
    `⚠️ Umbrella routing drift — projects sharing a chat destination have ` +
    `inconsistent inbound routing: ${drifted.join('; ')}. Repair the affected ` +
    `chat-routing.json files to consistent inbound config.`
  );
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
        const uuid = await resolveProjectUuid({ cwd, env: process.env }).catch(() => null);

        const parts: string[] = [];
        const tokenPresent =
          typeof config.chat_connections?.telegram?.bot_token === 'string' &&
          config.chat_connections.telegram.bot_token.length > 0;

        if (uuid !== null && uuid !== '') {
          const tg = (await readJsonFile<ChatRouting>(routingPath(uuid)))?.telegram;
          if (tg?.report_channel !== undefined && tokenPresent) {
            const held = isLeaseFresh(await readLease(uuid));
            const topic =
              tg.report_topic_id !== undefined ? ` topic ${String(tg.report_topic_id)}` : '';
            parts.push(
              held
                ? `✅ Chat: telegram${topic} configured; \`chat watch\` lease held (this session receives inbound).`
                : `🔌 Chat: telegram${topic} configured, but \`chat watch\` is NOT running — start it (Monitor: \`opensquid chat watch\`) so inbound reaches this session.`,
            );
          } else if (
            config.chat_connections?.slack !== undefined ||
            config.chat_connections?.discord !== undefined
          ) {
            parts.push(
              `🔌 Chat: a non-telegram platform is configured but telegram isn't wired for this ` +
                `project. Run \`opensquid setup\` to wire it.`,
            );
          } else {
            parts.push(
              `🔌 No chat connection wired for this project. Run \`opensquid setup\` to connect ` +
                `Telegram/Slack/Discord, or set \`chat.session_start_check: "off"\` in ` +
                `~/.opensquid/config.json to silence this.`,
            );
          }
        } else {
          parts.push(
            `🔌 No chat connection wired (project not resolved). Run \`opensquid setup\`, or set ` +
              `\`chat.session_start_check: "off"\` to silence.`,
          );
        }

        const drift = await detectUmbrellaDrift();
        if (drift !== null) parts.push(drift);

        const content = parts.join('\n');
        return ok(content.length > 0 ? { kind: 'inject_context' as const, content } : null);
      } catch {
        // Fail-quiet: a connection check must never break session start.
        return ok(null);
      }
    },
  });
}
