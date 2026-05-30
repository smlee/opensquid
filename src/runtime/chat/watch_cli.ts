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
 * Project-UUID resolution reuses `resolveProjectUuid` from `runtime/paths.js`
 * (env override → cwd walk for `.opensquid/project.json`) so it resolves
 * identically to the daemon — never reimplemented.
 *
 * Imports from: commander, ../paths.js, ./watch.js.
 * Imported by: src/cli.ts (registers the `chat` parent verb).
 */

import type { Command } from 'commander';

import { inboxFile, resolveProjectUuid } from '../paths.js';

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
  projectUuid?: string;
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
    .option('--project-uuid <uuid>', 'override project-UUID resolution')
    .action(async (opts: ChatWatchOptions) => {
      const uuid =
        opts.projectUuid ?? (await resolveProjectUuid({ cwd: process.cwd(), env: process.env }));
      if (uuid === null || uuid === '') {
        process.stderr.write(
          'chat watch: no project UUID. Set OPENSQUID_PROJECT_UUID, pass ' +
            '--project-uuid, or run `opensquid setup chat` to create ' +
            '`.opensquid/project.json`.\n',
        );
        process.exitCode = 1;
        return;
      }
      // Claim the live-session lease so the always-on daemon stays silent while
      // this session handles the project (T-DEL arbitration). Heartbeat keeps it
      // fresh; cleanup on exit + a SIGINT/SIGTERM handler remove it (staleness is
      // the fallback if we're killed ungracefully).
      await writeLease(uuid, resolveSessionId());
      const heartbeat = setInterval(() => {
        void refreshLease(uuid).catch(() => undefined);
      }, HEARTBEAT_MS);
      heartbeat.unref();
      const stopLease = async (): Promise<void> => {
        clearInterval(heartbeat);
        process.removeListener('SIGINT', onSignal);
        process.removeListener('SIGTERM', onSignal);
        await removeLease(uuid);
      };
      function onSignal(): void {
        void stopLease().finally(() => process.exit(0));
      }
      process.once('SIGINT', onSignal);
      process.once('SIGTERM', onSignal);

      // LL.3 (2026-05-30) — start the per-project inbound watcher in
      // parallel with the existing stdout streamer. The watcher
      // dispatches inbound rows as `inbound_channel` events to the
      // live session's loaded packs; the streamer keeps the
      // `Monitor`-stdout contract intact for backward-compat with
      // existing chat watch consumers.
      const stopInbound = await startInbound();
      try {
        await watch({
          inboxFile: inboxFile(uuid, opts.platform),
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
