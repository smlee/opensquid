/**
 * agent_bridge — chokidar-watched inbox JSONL → typed event emission
 * (WAB.2, 0.5.94).
 *
 * Authoritative source: `docs/tasks/WAB.1-architecture.md` decisions (a) +
 * (b); the warm-agent planning notes [not retained — see docs/tasks/WAB.1-architecture.md, which is] WAB.2 Part B spec.
 *
 * Reads the CANONICAL per-project inbox path:
 *   `~/.opensquid/projects/<projectUuid>/inbox/<platform>.jsonl`
 *
 * NO env-override hack. The WAB.1 revision #1 lifted the per-project
 * routing fix into WAB.2 Part A precisely so this bridge could read the
 * correct path day one. If the bridge ever ends up watching the orphan
 * inbox, that's a routing bug — fix it in Part A, not here.
 *
 * Boundary discipline:
 *   1. Inbox JSONL rows are written by the chat daemon (`src/channels`)
 *      in the on-disk row shape (snake_case). The bridge adapts that shape
 *      to the modern `InboundChatEvent` (camelCase, zod-validated).
 *   2. Validation happens at the boundary (every parsed line goes
 *      through `inboundChatEventSchema.parse` — malformed rows surface
 *      as a structured warn-and-skip, not a crash).
 *   3. Byte-offset cursor per file — append-only is the file contract
 *      (`O_APPEND` writes ≤ PIPE_BUF are atomic per POSIX); the bridge
 *      reads only the unread tail, never re-emits already-consumed rows.
 *   4. Truncation safety — if file size < cursor, the bridge resets the
 *      cursor to 0 and re-reads from the start (matches the legacy
 *      log-rotation pattern; chokidar fires `unlink` + `add` on rotate,
 *      and the cursor reset on `add` handles in-place truncate too).
 *
 * chokidar config (per spec):
 *   - `awaitWriteFinish: {stabilityThreshold: 50, pollInterval: 25}`
 *     suppresses partial-write events while keeping latency low
 *     (50ms ≪ typical Telegram inter-message gap; the legacy daemon
 *     batches inbox appends, so 50ms is enough headroom).
 *   - `ignoreInitial: false` — on bridge startup, we want to consume
 *     the existing tail (cursor starts at 0 → reads the whole file
 *     once → cursor advances → idle until next change). This is the
 *     correct restart-resume semantic for a long-running daemon.
 *
 * Imports from: chokidar, node:fs/promises, node:path, node:os, zod,
 *   ./event_bus.js, ./types.js.
 * Imported by: (future) dispatcher.ts, daemon.ts.
 */

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { type FSWatcher, watch } from 'chokidar';

import { umbrellaInboxDir } from '../paths.js';

import type { AgentEventBus } from './event_bus.js';
import { type InboundChatEvent, inboundChatEventSchema, type SessionKey } from './types.js';

// ---------------------------------------------------------------------------
// Inbox JSONL row shape (the on-disk contract written by the chat daemon).
// We re-declare it here rather than import a TS type because one of the
// WAB.1 contracts is "agent_bridge sees the inbox via its on-disk contract,
// not via TS imports." Keeping the shape inlined documents that contract at
// the bridge boundary.
// ---------------------------------------------------------------------------

interface LegacyInboxRow {
  v: 1;
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

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface TransportBridgeOptions {
  bus: AgentEventBus;
  projectUuid: string;
  /**
   * Owning umbrella id (T-CHAT-AS-TERMINAL CAT.5). When set, the bridge
   * watches the UMBRELLA inbox (`~/.opensquid/umbrellas/<id>/inbox/`) instead
   * of the per-project inbox, and stamps `umbrellaId` onto every emitted
   * event so the dispatcher's T-DEL arbitration can read the umbrella lease.
   * Omitted ⇒ legacy per-project inbox + lease (the general/project path).
   * `inboxRoot` (tests) still wins over both when provided.
   */
  umbrellaId?: string;
  /**
   * Override the inbox root (default: `~/.opensquid/projects/<uuid>/inbox/`,
   * or `~/.opensquid/umbrellas/<id>/inbox/` when `umbrellaId` is set).
   * Provided ONLY for tests — production callers must not pass this.
   * Distinct from "env-override" because there is no env var that flips
   * this; the caller wires it explicitly in test setUp.
   */
  inboxRoot?: string;
  /**
   * Glob restricting which files in the inbox dir we watch. Defaults to
   * `*.jsonl` so future platforms (discord.jsonl, slack.jsonl) auto-pick
   * up. Tests may narrow to `telegram.jsonl` for determinism.
   */
  fileGlob?: string;
  /** Test seam — usePolling forces chokidar's polling backend. */
  usePolling?: boolean;
  /** Structured warn sink for malformed rows + watcher errors. */
  onWarn?: (message: string) => void;
  /**
   * Test/observability seam (T-FLAKE-TRANSPORT-BRIDGE) — fires on watcher
   * events + consume entry. No-op when unset; sibling of `onWarn` (same trust
   * model). Observability ONLY — putting logic here is misuse.
   */
  onEvent?: (kind: 'add' | 'change' | 'unlink' | 'consume', path: string) => void;
}

// ---------------------------------------------------------------------------
// Constants (top-of-file for ops visibility)
// ---------------------------------------------------------------------------

const AWAIT_WRITE_FINISH_STABILITY_MS = 50;
const AWAIT_WRITE_FINISH_POLL_MS = 25;
/** TBW.1: bound on the chokidar ready wait — pathological only (real inboxes
 *  scan in milliseconds); the diagnostic names the pre-research. */
const READY_TIMEOUT_MS = 30_000;

const noopWarn: (message: string) => void = () => {
  /* default sink */
};

// ---------------------------------------------------------------------------
// InboxTransportBridge
// ---------------------------------------------------------------------------

export class InboxTransportBridge {
  private watcher: FSWatcher | null = null;
  /** TBW.1: resolves an in-flight start() ready-wait when shutdown() runs —
   *  code-owned close semantics (chokidar's close()-mid-init emissions are
   *  undocumented; we never depend on them). */
  private closeRequested: (() => void) | null = null;
  /** Per-file byte-offset cursor. Key = absolute file path. */
  private readonly cursors = new Map<string, number>();
  /** Per-file in-flight read serializer — chokidar may fire `change` twice
   *  for one write burst; we want exactly one read at a time per file. */
  private readonly readChains = new Map<string, Promise<void>>();
  private readonly warn: (message: string) => void;
  private readonly inboxDir: string;
  private readonly fileGlob: string;
  private stopped = false;

  constructor(private readonly opts: TransportBridgeOptions) {
    this.warn = opts.onWarn ?? noopWarn;
    this.inboxDir =
      opts.inboxRoot ??
      (opts.umbrellaId !== undefined
        ? umbrellaInboxDir(opts.umbrellaId)
        : join(homedir(), '.opensquid', 'projects', opts.projectUuid, 'inbox'));
    this.fileGlob = opts.fileGlob ?? '*.jsonl';
  }

  /** Open the chokidar watcher. Re-call after `shutdown()` throws. */
  async start(): Promise<void> {
    if (this.watcher !== null) {
      throw new Error('InboxTransportBridge.start: already started');
    }
    if (this.stopped) {
      throw new Error('InboxTransportBridge.start: cannot restart a stopped bridge');
    }
    // Ensure the inbox dir exists before watching — chokidar swallows
    // ENOENT silently on the watched root, which would manifest as
    // "no events ever fire" with no diagnostic.
    await fs.mkdir(this.inboxDir, { recursive: true });

    const pattern = join(this.inboxDir, this.fileGlob);
    this.watcher = watch(pattern, {
      awaitWriteFinish: {
        stabilityThreshold: AWAIT_WRITE_FINISH_STABILITY_MS,
        pollInterval: AWAIT_WRITE_FINISH_POLL_MS,
      },
      // ignoreInitial=false → on startup, chokidar fires `add` for
      // each existing file → bridge reads the existing tail with
      // cursor=0 → emits already-buffered messages on resume. This
      // is the correct daemon-restart semantic.
      ignoreInitial: false,
      ...(this.opts.usePolling !== undefined ? { usePolling: this.opts.usePolling } : {}),
    });

    this.watcher.on('add', (path) => {
      this.opts.onEvent?.('add', path);
      this.scheduleConsume(path);
    });
    this.watcher.on('change', (path) => {
      this.opts.onEvent?.('change', path);
      this.scheduleConsume(path);
    });
    this.watcher.on('unlink', (path) => {
      // Rotation / truncation — drop cursor so next `add` starts at 0.
      this.opts.onEvent?.('unlink', path);
      this.cursors.delete(path);
    });
    this.watcher.on('error', (err) => {
      this.warn(
        `[agent_bridge.transport] watcher error: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

    // TBW.1 — the watcher is NOT live until chokidar's `ready`: under both
    // backends a file created during the initial-scan window can produce
    // ZERO events forever (the 2026-06-10 captured flake: rows on disk,
    // events {}). Gate start() on ready, then self-heal-scan the dir once.
    const watcher = this.watcher;
    await new Promise<void>((resolveReady, rejectReady) => {
      const onReady = (): void => {
        cleanup();
        resolveReady();
      };
      const onError = (err: unknown): void => {
        cleanup();
        rejectReady(err instanceof Error ? err : new Error(String(err)));
      };
      const timer = setTimeout(() => {
        cleanup();
        rejectReady(
          new Error(
            'InboxTransportBridge.start: watcher ready not reached in 30s (see T-fix-transport-bridge-watcher-race pre-research)',
          ),
        );
      }, READY_TIMEOUT_MS);
      const cleanup = (): void => {
        clearTimeout(timer);
        watcher.off('ready', onReady);
        watcher.off('error', onError);
        this.closeRequested = null;
      };
      this.closeRequested = (): void => {
        cleanup();
        resolveReady(); // shutdown() owns the close; start() resolves clean
      };
      watcher.once('ready', onReady);
      watcher.once('error', onError);
    });
    if (this.stopped) return; // shutdown won the race — nothing to self-heal

    // Self-heal: files created during the scan window exist on disk but may
    // have produced no events (the captured profile). One readdir, fileGlob-
    // filtered; cursor idempotency makes a duplicate consume a no-op.
    const entries = await fs.readdir(this.inboxDir).catch(() => [] as string[]);
    for (const name of entries) {
      if (this.matchesFileGlob(name)) this.scheduleConsume(join(this.inboxDir, name));
    }
  }

  /** The bridge's fileGlob is a basename pattern ('*.jsonl' or a literal like
   *  'telegram.jsonl'); `*` is the one supported wildcard. */
  private matchesFileGlob(name: string): boolean {
    if (!this.fileGlob.includes('*')) return name === this.fileGlob;
    const escaped = this.fileGlob
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    return new RegExp(`^${escaped}$`).test(name);
  }

  /** Close the watcher; drain in-flight reads. Idempotent. */
  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.closeRequested?.();
    const w = this.watcher;
    this.watcher = null;
    if (w !== null) await w.close();
    // Drain any in-flight reads so callers awaiting shutdown can trust
    // that no further emits will happen after resolve.
    await Promise.allSettled(Array.from(this.readChains.values()));
    this.readChains.clear();
  }

  /**
   * Test-only hook — synchronously reports the current cursor for a file.
   * Production callers do not depend on this; exported for invariant
   * assertions in the audit harness.
   */
  cursorFor(path: string): number | undefined {
    return this.cursors.get(path);
  }

  // --- private ---

  /** Serialize reads per-file to prevent overlapping consumers. */
  private scheduleConsume(path: string): void {
    if (this.stopped) return;
    const prev = this.readChains.get(path) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined) // never let a prior failure poison the chain
      .then(() => this.consumeTail(path));
    this.readChains.set(path, next);
  }

  /**
   * Read from the cursor to end-of-file; parse each newline-delimited row;
   * validate via zod; emit `inbound`. Cursor advances by the byte length
   * of every line we consumed (including the trailing `\n`), so a
   * partial trailing line is held for the next `change` event.
   */
  private async consumeTail(path: string): Promise<void> {
    if (this.stopped) return;
    this.opts.onEvent?.('consume', path);
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        this.cursors.delete(path);
        return;
      }
      this.warn(
        `[agent_bridge.transport] stat failed ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    const size = stat.size;
    let cursor = this.cursors.get(path) ?? 0;
    if (size < cursor) {
      // Truncation in-place — reset to 0 and re-read.
      cursor = 0;
    }
    if (size === cursor) return;

    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(path, 'r');
      const length = size - cursor;
      const buf = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buf, 0, length, cursor);
      if (bytesRead === 0) return;
      // Split on newlines; preserve a trailing partial (no \n) by NOT
      // emitting its bytes — leave them under the cursor for next time.
      const slice = buf.subarray(0, bytesRead).toString('utf8');
      let consumedBytes = 0;
      let lineStart = 0;
      while (lineStart < slice.length) {
        const newlineIdx = slice.indexOf('\n', lineStart);
        if (newlineIdx === -1) break; // partial trailing line — leave for next read
        const line = slice.slice(lineStart, newlineIdx);
        // Byte length of the consumed segment (including the \n).
        // We measure on the original slice because multibyte chars
        // shift index↔byte mapping; Buffer.byteLength of just `line`
        // misses the \n itself.
        consumedBytes += Buffer.byteLength(line, 'utf8') + 1;
        lineStart = newlineIdx + 1;
        const trimmed = line.trim();
        if (trimmed === '') continue;
        this.emitRow(path, trimmed);
      }
      this.cursors.set(path, cursor + consumedBytes);
    } catch (err) {
      this.warn(
        `[agent_bridge.transport] read failed ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      await handle?.close().catch(() => {
        /* close errors are non-fatal */
      });
    }
  }

  /** Parse one JSONL line, adapt to InboundChatEvent, emit. */
  private emitRow(path: string, line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      this.warn(
        `[agent_bridge.transport] malformed JSON in ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    const adapted = this.adaptLegacyRow(parsed);
    if (adapted === null) return; // warn already logged inside adapter
    const result = inboundChatEventSchema.safeParse(adapted);
    if (!result.success) {
      this.warn(`[agent_bridge.transport] schema mismatch in ${path}: ${result.error.message}`);
      return;
    }
    this.opts.bus.emit('inbound', result.data);
  }

  /**
   * Map legacy snake_case `InboxMessage` shape → modern camelCase
   * `InboundChatEvent`. Returns null + warns when the row doesn't look
   * like a legacy InboxMessage at all (forward-compat: future writers
   * with a `kind: 'inbound_message'` field that already matches the
   * modern schema would skip this adapter; we let zod take the shot).
   */
  private adaptLegacyRow(raw: unknown): unknown {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      this.warn(`[agent_bridge.transport] not an object: ${JSON.stringify(raw)}`);
      return null;
    }
    const r = raw as Partial<LegacyInboxRow> & Record<string, unknown>;
    // If the row is already in modern shape (has `kind: 'inbound_message'`),
    // pass through; zod schema parse below will validate it.
    if (r.kind === 'inbound_message') return r;
    // Legacy shape: build SessionKey from platform + channel + thread_id.
    if (typeof r.platform !== 'string' || typeof r.channel !== 'string') {
      this.warn(
        `[agent_bridge.transport] missing platform/channel: ${JSON.stringify(r).slice(0, 120)}`,
      );
      return null;
    }
    if (r.platform !== 'telegram' && r.platform !== 'discord' && r.platform !== 'slack') {
      this.warn(`[agent_bridge.transport] unsupported platform '${r.platform}'`);
      return null;
    }
    // After the negative guard above, r.platform is narrowed to the union.
    // chatId is the native id portion of the channel (`<platform>:<native>`).
    const colonIdx = r.channel.indexOf(':');
    if (colonIdx === -1) {
      this.warn(`[agent_bridge.transport] malformed channel '${r.channel}'`);
      return null;
    }
    const chatId = r.channel.slice(colonIdx + 1);
    const sessionKey: SessionKey = {
      platform: r.platform,
      chatId,
      ...(typeof r.thread_id === 'string' && r.thread_id.length > 0
        ? { threadId: r.thread_id }
        : {}),
    };
    const event: InboundChatEvent = {
      kind: 'inbound_message',
      sessionKey,
      messageId: String(r.id ?? ''),
      sender: {
        id: String(r.sender_id ?? ''),
        ...(typeof r.sender === 'string' && r.sender.length > 0 ? { name: r.sender } : {}),
      },
      text: typeof r.text === 'string' ? r.text : '',
      receivedAt: String(r.received_at ?? ''),
      enqueuedAt: String(r.enqueued_at ?? ''),
      projectUuid: this.opts.projectUuid,
      // Stamp the owning umbrella (CAT.5) so the dispatcher's arbitration
      // reads the umbrella lease, not the project lease.
      ...(this.opts.umbrellaId !== undefined ? { umbrellaId: this.opts.umbrellaId } : {}),
      raw: r,
    };
    return event;
  }
}
