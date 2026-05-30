/**
 * Inbound watcher (T-L3-LOOP LL.3) — chokidar-backed tail of every live
 * project's `~/.opensquid/projects/<uuid>/inbox/<platform>.jsonl`. On each
 * new row, parses to `InboxRow`, resolves the target session via LL.2,
 * constructs an `InboundChannelEvent`, and calls `dispatchEvent` so any
 * loaded pack with `triggers: [{kind: 'inbound_channel', ...}]` fires.
 *
 * "Lazy push" semantics per L7: rows with no fresh session are appended
 * to `~/.opensquid/projects/<uuid>/inbox/unrouted.jsonl` + LEFT in the
 * inbox (no ack). The LL.4 UPS hook drains the backlog on demand at the
 * next session prompt-submit.
 *
 * The watcher itself is dispatch-only — it does NOT inject into the
 * `additionalContext` envelope (that's LL.4's job at UPS fire time).
 * Splitting the two keeps dispatcher semantics (per-event) cleanly
 * distinct from the additionalContext semantics (per-turn aggregation).
 *
 * Performance: chokidar with `awaitWriteFinish: { stabilityThreshold: 100,
 * pollInterval: 50 }` (matches the precedent in
 * `src/runtime/agent_bridge/transport_bridge.ts`). Byte-offset tracking
 * via `stat.size`; re-read only the appended slice on each `change`.
 *
 * Durability: byte-offset state is in-memory only. Watcher restart loses
 * offsets → re-reads from start → multi-fires every existing row. The
 * LL.4 ack-set is the durability boundary — duplicate dispatches are
 * harmless because LL.4 dedups via `acked.jsonl`. Documented intent.
 *
 * Imports from: chokidar, node:fs/promises, node:path, ./inbox,
 *   ./session_routing, ../paths, ../bootstrap, ../hooks/dispatch.
 * Imported by: src/runtime/chat/watch_cli.ts (lifecycle start/stop).
 */

import { appendFile, mkdir, open, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import chokidar from 'chokidar';

import { buildRegistry, loadActivePacks } from '../bootstrap.js';
import type { InboundChannelEvent } from '../event.js';
import { dispatchEvent } from '../hooks/dispatch.js';
import { OPENSQUID_HOME, inboxDir } from '../paths.js';

import { InboxRow, type Platform } from './inbox.js';
import { resolveAllLiveProjects, resolveLiveSessionId } from './session_routing.js';

const PLATFORMS = ['telegram', 'slack', 'discord'] as const;
const RESCAN_MS = 60_000;

interface WatcherState {
  watcher: chokidar.FSWatcher;
  offsets: Map<string, number>;
}

/**
 * Build a stable channelUri per L9: `<platform>://<channel>[/<thread_id>]`.
 * Lossless round-trip with `platformFromChannelUri`.
 */
export function buildChannelUri(row: InboxRow): string {
  const base = `${row.platform}://${row.channel}`;
  return row.thread_id !== undefined ? `${base}/${row.thread_id}` : base;
}

/**
 * Parse the scheme prefix from a channelUri. Used by the dispatcher filter
 * to compare against `Trigger.channel` (which is a bare literal like
 * `'telegram'`). Returns null for unrecognized schemes.
 */
export function platformFromChannelUri(uri: string): Platform | null {
  const m = /^(telegram|slack|discord):\/\//.exec(uri);
  if (m === null) return null;
  return m[1] as Platform;
}

/**
 * Append a row to the project's `inbox/unrouted.jsonl`. Best-effort: never
 * throws (parent dir created on demand; append errors swallowed).
 */
async function appendUnrouted(projectUuid: string, row: InboxRow, reason: string): Promise<void> {
  const path = join(inboxDir(projectUuid), 'unrouted.jsonl');
  const entry = {
    v: 1,
    occurred_at: new Date().toISOString(),
    project_uuid: projectUuid,
    message_id: row.id,
    platform: row.platform,
    reason,
  };
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // swallow — unrouted log is best-effort
  }
}

/**
 * Process one newly-appended inbox row: resolve target session, fire
 * event, or record unrouted. Pure-ish (one lease read + one dispatch).
 */
export async function processRow(projectUuid: string, row: InboxRow): Promise<void> {
  const sessionId = await resolveLiveSessionId(projectUuid);
  if (sessionId === null) {
    await appendUnrouted(projectUuid, row, 'no_fresh_live_session_lease');
    return;
  }

  const event: InboundChannelEvent = {
    kind: 'inbound_channel',
    channelUri: buildChannelUri(row),
    sender: row.sender,
    text: row.text,
    receivedAt: row.received_at,
    ...(row.thread_id !== undefined ? { threadKey: row.thread_id } : {}),
  };

  const packs = await loadActivePacks(sessionId);
  const registry = await buildRegistry();
  await dispatchEvent(event, packs, registry, sessionId);
}

/**
 * Read appended bytes from `filePath` since `lastOffset`, parse each line,
 * dispatch each valid InboxRow. Updates the offset map. Handles truncation
 * (size < lastOffset) by resetting to 0 and re-reading from start.
 */
async function drainAppended(
  projectUuid: string,
  filePath: string,
  state: WatcherState,
): Promise<void> {
  const s = await stat(filePath).catch(() => null);
  if (s === null) return;
  const lastOffset = state.offsets.get(filePath) ?? 0;
  if (s.size === lastOffset) return;
  if (s.size < lastOffset) state.offsets.set(filePath, 0);

  const start = state.offsets.get(filePath) ?? 0;
  const handle = await open(filePath, 'r');
  try {
    const { buffer, bytesRead } = await handle.read({
      buffer: Buffer.alloc(s.size - start),
      position: start,
    });
    state.offsets.set(filePath, start + bytesRead);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    for (const line of text.split('\n')) {
      if (line.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const safe = InboxRow.safeParse(parsed);
      if (!safe.success) continue;
      await processRow(projectUuid, safe.data);
    }
  } finally {
    await handle.close();
  }
}

/** Extract `<uuid>` from `~/.opensquid/projects/<uuid>/inbox/<platform>.jsonl`. */
export function extractProjectUuid(path: string): string | null {
  const m = /projects\/([^/]+)\/inbox\//.exec(path);
  return m === null ? null : (m[1] ?? null);
}

/**
 * Start watching every live project's inbox files. Returns a cleanup
 * function the CLI calls on exit. Re-scans every 60s to pick up projects
 * that come online after the watcher started.
 */
export async function startInboundWatcher(): Promise<() => Promise<void>> {
  const state: WatcherState = {
    watcher: chokidar.watch([], {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    }),
    offsets: new Map(),
  };

  async function attachLiveProjects(): Promise<void> {
    const bindings = await resolveAllLiveProjects();
    for (const { projectUuid } of bindings) {
      for (const platform of PLATFORMS) {
        const path = join(OPENSQUID_HOME(), 'projects', projectUuid, 'inbox', `${platform}.jsonl`);
        state.watcher.add(path);
      }
    }
  }

  await attachLiveProjects();
  const rescan = setInterval(() => {
    void attachLiveProjects();
  }, RESCAN_MS);

  state.watcher.on('add', (filePath: string) => {
    const uuid = extractProjectUuid(filePath);
    if (uuid !== null) void drainAppended(uuid, filePath, state);
  });
  state.watcher.on('change', (filePath: string) => {
    const uuid = extractProjectUuid(filePath);
    if (uuid !== null) void drainAppended(uuid, filePath, state);
  });

  return async () => {
    clearInterval(rescan);
    await state.watcher.close();
  };
}
