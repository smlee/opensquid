/**
 * `opensquid chat watch` — the inbox stream-source for the harness `Monitor`
 * tool (Track T-TR, TR.1). Resolves the active project's inbox JSONL and
 * streams NEW inbound messages to stdout, one formatted line per message.
 *
 * This is a NEW top-level `chat` verb group, distinct from `opensquid setup
 * chat` (the chat-agent wizard). The agent wraps it:
 *   Monitor({ command: "node dist/cli.js chat watch", persistent: true })
 * so each appended message → one in-chat event (no cron — see
 * docs/tasks/T-telegram-realtime.md L3 on why auto-start is an agent
 * convention, not a CLI side-effect).
 *
 * Umbrella resolution (T-CHAT-AS-TERMINAL CAT.1c): chat is keyed by UMBRELLA,
 * not per-cwd project_uuid. The cwd is resolved to its umbrella via
 * `loadChannelsConfig()` + `resolveUmbrellaForCwd` (longest-prefix over
 * `members`). `channels.json` is synthesized at the CAT.1d cutover, so an
 * absent config / unresolved umbrella exits with a clear message (graceful,
 * never throws). The `--umbrella` flag overrides resolution for tests + ops.
 *
 * Imports from: commander, ../../channels/routing.js, ../paths.js, ./watch.js.
 * Imported by: src/cli.ts (registers the `chat` parent verb).
 */

import type { Command } from 'commander';

import { loadChannelsConfig, resolveUmbrellaForCwd } from '../../channels/routing.js';
import { umbrellaInboxFile, umbrellaLiveSessionLease } from '../paths.js';

import {
  HEARTBEAT_MS,
  refreshLease,
  removeLease,
  resolveSessionId,
  writeLease,
} from './live_session_lease.js';
import { startInboundWatcher } from './inbound_watch.js';
import { formatRow, watchInbox, type InboxRow, type WatchInboxOpts } from './watch.js';

interface ChatWatchOptions {
  platform: string;
  raw: boolean;
  mentionsOnly: boolean;
  umbrella?: string;
}

/** Injection seam — tests stub `watch` so the action returns instead of
 *  blocking on the real (forever-running) watcher. Mirrors AgentBridgeCliDeps.
 *  LL.3: `startInbound` is also injectable so lifecycle tests don't spin up
 *  a real chokidar tail. */
export interface ChatWatchDeps {
  watch?: (opts: WatchInboxOpts) => Promise<void>;
  startInbound?: () => Promise<() => Promise<void>>;
}

export function registerChatWatch(program: Command, deps: ChatWatchDeps = {}): Command {
  const watch = deps.watch ?? watchInbox;
  const startInbound = deps.startInbound ?? startInboundWatcher;
  const chat = program.command('chat').description('Live chat inbound/outbound helpers.');
  chat
    .command('watch')
    .description('Stream NEW inbound messages to stdout for the harness Monitor (no cron).')
    .option('--platform <name>', 'inbox platform (telegram, discord, …)', 'telegram')
    .option('--raw', 'emit raw JSONL rows instead of the formatted line', false)
    .option('--mentions-only', 'only emit rows where mentions_bot is true', false)
    .option('--umbrella <id>', 'override cwd→umbrella resolution')
    .action(async (opts: ChatWatchOptions) => {
      // CAT.1c: resolve the cwd to its UMBRELLA via channels.json (the single
      // authoritative routing source). `--umbrella` overrides for tests/ops.
      // Absent config / unresolved umbrella → exit cleanly (channels.json is
      // synthesized at the CAT.1d cutover; before then there is no inbox).
      let umbrellaId = opts.umbrella ?? null;
      if (umbrellaId === null) {
        const cfg = await loadChannelsConfig();
        umbrellaId = cfg === null ? null : resolveUmbrellaForCwd(cfg, process.cwd());
      }
      if (umbrellaId === null || umbrellaId === '') {
        process.stderr.write(
          'chat watch: no umbrella for this cwd. Pass --umbrella, or add a ' +
            'matching `members` prefix to an umbrella in ~/.opensquid/channels.json ' +
            '(run `opensquid setup chat` to wire it).\n',
        );
        process.exitCode = 1;
        return;
      }
      const leasePath = umbrellaLiveSessionLease(umbrellaId);
      // Claim the live-session lease so the always-on daemon stays silent while
      // this session handles the umbrella (T-DEL arbitration). Heartbeat keeps it
      // fresh; cleanup on exit + a SIGINT/SIGTERM handler remove it (staleness is
      // the fallback if we're killed ungracefully).
      await writeLease(leasePath, resolveSessionId());
      const heartbeat = setInterval(() => {
        void refreshLease(leasePath).catch(() => undefined);
      }, HEARTBEAT_MS);
      heartbeat.unref();
      const stopLease = async (): Promise<void> => {
        clearInterval(heartbeat);
        process.removeListener('SIGINT', onSignal);
        process.removeListener('SIGTERM', onSignal);
        await removeLease(leasePath);
      };
      function onSignal(): void {
        void stopLease().finally(() => process.exit(0));
      }
      process.once('SIGINT', onSignal);
      process.once('SIGTERM', onSignal);

      // LL.3 (2026-05-30) — start the per-umbrella inbound watcher in
      // parallel with the existing stdout streamer. The watcher
      // dispatches inbound rows as `inbound_channel` events to the
      // live session's loaded packs; the streamer keeps the
      // `Monitor`-stdout contract intact for backward-compat with
      // existing chat watch consumers.
      const stopInbound = await startInbound();
      try {
        await watch({
          inboxFile: umbrellaInboxFile(umbrellaId, opts.platform),
          mentionsOnly: opts.mentionsOnly,
          format: opts.raw ? (r: InboxRow) => JSON.stringify(r) : formatRow,
          // Flush one line per message — Monitor reads stdout line-delimited.
          out: (line) => process.stdout.write(line + '\n'),
          onWarn: (message) => process.stderr.write(message + '\n'),
        });
      } finally {
        await stopInbound().catch(() => undefined);
        await stopLease();
      }
    });
  return chat;
}
