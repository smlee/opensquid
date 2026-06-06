/**
 * `chat watch` core — tail an append-only chat inbox JSONL, emitting only
 * NEW rows (Track T-TR, TR.1). The agent wraps `opensquid chat watch` in the
 * harness `Monitor` tool so each appended message becomes an in-chat event the
 * instant it lands — event-driven push, no cron/interval polling.
 *
 * Design (per docs/tasks/T-telegram-realtime.md):
 *   - NEW-ONLY (L2): start the cursor at the file's current EOF so the backlog
 *     is skipped (still reachable via `chat_poll_inbox`). The file may not exist
 *     yet (created on the first message) — chokidar fires `add` on creation.
 *   - The inbox is read via its ON-DISK CONTRACT, not a shared TS type — the
 *     same WAB.1 design that has `agent_bridge/transport_bridge.ts` re-inline
 *     the row shape rather than import a shared TS type. So
 *     `chat watch` is an independent consumer of the file format, by design.
 *   - READS ARE SERIALIZED: chokidar can fire `change` twice for one write
 *     burst; without serialization two concurrent reads would advance the
 *     cursor over the same bytes and double-emit. We chain reads so exactly one
 *     runs at a time (mirrors transport_bridge.ts's `readChains`).
 *   - awaitWriteFinish coalesces partial-write events; constants match
 *     transport_bridge.ts so both inbox consumers behave identically.
 *
 * Never throws on bad input: a malformed JSONL line is skipped (routed to
 * `onWarn`), the watcher stays up.
 *
 * Imports from: chokidar, node:fs/promises.
 * Imported by: src/runtime/chat/watch_cli.ts.
 */

import { mkdir, open, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { watch as chokidarWatch, type FSWatcher } from 'chokidar';

// Match transport_bridge.ts so the two inbox consumers coalesce writes
// identically. Stability = quiet period before a write is "finished".
const AWAIT_WRITE_FINISH_STABILITY_MS = 50;
const AWAIT_WRITE_FINISH_POLL_MS = 25;

const noopWarn = (): void => {
  /* default: swallow */
};

/**
 * One inbound row as the chat-daemon appends it (mirrors `LegacyInboxRow` in
 * `transport_bridge.ts` — the on-disk contract). `thread_id` is OPTIONAL: DMs
 * have no topic thread, so the formatter must not print `undefined`.
 */
export interface InboxRow {
  id: string;
  thread_id?: string;
  platform: string;
  channel: string;
  sender: string;
  sender_id: string;
  text: string;
  received_at: string;
  enqueued_at: string;
  mentions_bot: boolean;
}

export interface WatchInboxOpts {
  /** Absolute path to the inbox JSONL (see `paths.inboxFile`). */
  inboxFile: string;
  /** Only emit rows whose `mentions_bot` is true (L4 default: false = all). */
  mentionsOnly: boolean;
  /** Line formatter — default `formatRow`, or `JSON.stringify` for `--raw`. */
  format: (row: InboxRow) => string;
  /** Sink for each formatted line. Production: `(l) => process.stdout.write(l + '\n')`. */
  out: (line: string) => void;
  /** Malformed-row + watcher-error sink. Default: swallow. */
  onWarn?: (message: string) => void;
  /** Test seam — force chokidar's polling backend. */
  usePolling?: boolean;
  /** Resolves `watchInbox` + closes the watcher (tests/teardown). */
  signal?: AbortSignal;
}

/**
 * Default human-readable line. DMs have no `thread_id` → fall back to the
 * channel so we never print `[tg undefined]`.
 */
export function formatRow(row: InboxRow): string {
  const platform = row.platform === 'telegram' ? 'tg' : row.platform;
  const where = row.thread_id ?? row.channel ?? 'dm';
  return `[${platform} ${where}] ${row.sender}: ${row.text}`;
}

/**
 * Tail an append-only JSONL inbox, emitting only rows appended after start.
 * Resolves when `opts.signal` aborts (tests); in production the `Monitor`
 * process lifetime owns the watcher and this never resolves.
 */
export async function watchInbox(opts: WatchInboxOpts): Promise<void> {
  const warn = opts.onWarn ?? noopWarn;
  // Ensure the inbox dir exists so chokidar reliably catches the file's `add`
  // on first message — watching a path deep in a not-yet-created tree can miss
  // the creation event. The daemon writes here too; mkdir -p is idempotent.
  await mkdir(dirname(opts.inboxFile), { recursive: true }).catch(noopWarn);
  // L2: skip backlog — begin at current EOF (0 if the file doesn't exist yet).
  let cursor = await stat(opts.inboxFile)
    .then((s) => s.size)
    .catch(() => 0);
  let leftover = '';
  // Serialize reads: one drain at a time so a double `change` can't re-read
  // the same bytes. Each event extends the chain.
  let chain: Promise<void> = Promise.resolve();

  const drain = async (): Promise<void> => {
    const size = await stat(opts.inboxFile)
      .then((s) => s.size)
      .catch(() => -1);
    if (size < 0) return; // gone mid-flight
    if (size < cursor) {
      cursor = 0; // truncation / rotation
      leftover = '';
    }
    if (size === cursor) return; // nothing new (or a coalesced double-fire)
    const fh = await open(opts.inboxFile, 'r');
    try {
      const buf = Buffer.alloc(size - cursor);
      await fh.read(buf, 0, buf.length, cursor);
      cursor = size;
      leftover += buf.toString('utf8');
      const parts = leftover.split('\n');
      leftover = parts.pop() ?? ''; // carry a partial trailing line
      for (const part of parts) {
        if (part.trim() === '') continue;
        let row: InboxRow;
        try {
          row = JSON.parse(part) as InboxRow;
        } catch {
          warn(`chat watch: skipped malformed inbox line: ${part.slice(0, 120)}`);
          continue;
        }
        if (opts.mentionsOnly && !row.mentions_bot) continue;
        opts.out(opts.format(row));
      }
    } finally {
      await fh.close();
    }
  };

  const schedule = (): void => {
    chain = chain.then(drain).catch((e) => {
      warn(`chat watch: read failed: ${e instanceof Error ? e.message : String(e)}`);
    });
  };

  // Watch the inbox DIRECTORY (glob), not the bare file: native backends
  // (macOS FSEvents) reliably detect a file's creation + appends when watching
  // its parent dir, but can miss events on a single not-yet-existent file path.
  // This mirrors transport_bridge.ts (`join(inboxDir, '*.jsonl')`); we filter
  // events down to our target platform file. (Smoke-test-verified.)
  const targetName = basename(opts.inboxFile);
  const watcher: FSWatcher = chokidarWatch(join(dirname(opts.inboxFile), '*.jsonl'), {
    ignoreInitial: true, // L2: the `tail -n 0` equivalent — skip what's already there
    awaitWriteFinish: {
      stabilityThreshold: AWAIT_WRITE_FINISH_STABILITY_MS,
      pollInterval: AWAIT_WRITE_FINISH_POLL_MS,
    },
    usePolling: opts.usePolling ?? false,
  });
  const onEvent = (changed: string): void => {
    if (basename(changed) === targetName) schedule();
  };
  watcher.on('add', onEvent); // file created after start
  watcher.on('change', onEvent); // appended
  watcher.on('error', (e: unknown) =>
    warn(`chat watch: watcher error: ${e instanceof Error ? e.message : String(e)}`),
  );

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      void watcher.close().then(() => resolve());
    };
    if (opts.signal?.aborted) {
      stop();
      return;
    }
    opts.signal?.addEventListener('abort', stop, { once: true });
  });
}
