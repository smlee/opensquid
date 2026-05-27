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
 * Project-UUID resolution reuses the agent_bridge chain
 * (`resolveProjectUuidFromEnv` → cwd walk for `.opensquid/project.json`) so it
 * resolves identically to the daemon — never reimplemented.
 *
 * Imports from: commander, ../agent_bridge/cli.js, ../agent_bridge/daemon.js,
 *   ../paths.js, ./watch.js.
 * Imported by: src/cli.ts (registers the `chat` parent verb).
 */

import type { Command } from 'commander';

import { walkForProjectUuid } from '../agent_bridge/cli.js';
import { resolveProjectUuidFromEnv } from '../agent_bridge/daemon.js';
import { inboxFile } from '../paths.js';

import { formatRow, watchInbox, type InboxRow, type WatchInboxOpts } from './watch.js';

interface ChatWatchOptions {
  platform: string;
  raw: boolean;
  mentionsOnly: boolean;
  projectUuid?: string;
}

/** Injection seam — tests stub `watch` so the action returns instead of
 *  blocking on the real (forever-running) watcher. Mirrors AgentBridgeCliDeps. */
export interface ChatWatchDeps {
  watch?: (opts: WatchInboxOpts) => Promise<void>;
}

export function registerChatWatch(program: Command, deps: ChatWatchDeps = {}): Command {
  const watch = deps.watch ?? watchInbox;
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
        opts.projectUuid ??
        resolveProjectUuidFromEnv(process.env) ??
        (await walkForProjectUuid(process.cwd()));
      if (uuid === null || uuid === '') {
        process.stderr.write(
          'chat watch: no project UUID. Set OPENSQUID_PROJECT_UUID, pass ' +
            '--project-uuid, or run `opensquid setup chat` to create ' +
            '`.opensquid/project.json`.\n',
        );
        process.exitCode = 1;
        return;
      }
      await watch({
        inboxFile: inboxFile(uuid, opts.platform),
        mentionsOnly: opts.mentionsOnly,
        format: opts.raw ? (r: InboxRow) => JSON.stringify(r) : formatRow,
        // Flush one line per message — Monitor reads stdout line-delimited.
        out: (line) => process.stdout.write(line + '\n'),
        onWarn: (message) => process.stderr.write(message + '\n'),
      });
    });
  return chat;
}
