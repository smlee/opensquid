/**
 * agent_bridge — append-only JSONL persistence for warm-pool session
 * history (WAB.3, 0.5.95).
 *
 * Authoritative spec: `docs/tasks/T-warm-agent-chat-bridge.md` WAB.3.
 * Architecture: `docs/tasks/WAB.1-architecture.md` decision (c) + Section 2
 * module layout (≤200 LOC budget for this file).
 *
 * On-disk contract:
 *   - One JSONL file per session at
 *     `~/.opensquid/agent-bridge/sessions/<slug>.jsonl`.
 *   - Each row is exactly one serialized `ChatHistoryEntry`.
 *   - Writes are APPEND-ONLY (`fs.appendFile`); files are never truncated
 *     or rewritten. Restart-resume reads the full file front-to-back into
 *     memory at session creation, so history order = byte order.
 *
 * Why JSONL (not SQLite):
 *   - Append-only matches the access pattern (1 turn = N entries appended;
 *     never a partial update).
 *   - `O_APPEND` writes ≤ `PIPE_BUF` (4KB on macOS / 4KB on Linux) are
 *     atomic per POSIX. Most history entries (text content) are well under
 *     this. Long entries split JSONL `\n` cleanly so the reader's
 *     line-by-line tolerance handles interleaved partial writes too.
 *   - Same shape as the chat-daemon inbox and the drift catalog
 *     (`src/runtime/drift_catalog.ts`) — consistent file format makes ops
 *     + grepability easier.
 *
 * Slug encoding (filesystem safety):
 *   - SessionKey slug form is `<platform>:<chatId>[:<threadId>]` — colons
 *     are not safe on Windows + interact poorly with shell tooling.
 *   - We replace `:` with `__` (rare in identifiers so we can recover the
 *     original by inverse on debug), then replace any character that is
 *     NOT alphanumeric / `-` / `_` with `_`. This avoids path-traversal
 *     vectors (no `/`, no `..`, no nulls) while keeping the filename
 *     readable for the common case (Telegram + Discord ids are
 *     alphanumeric with optional `-` prefix for TG supergroups).
 *
 * Tolerance:
 *   - Malformed JSON line on load: skipped + reported via `onWarn`; valid
 *     rows still load. Never throws on a corrupt line.
 *   - Schema-mismatched line on load: same — warn + skip.
 *   - Missing file on load: returns `[]` (fresh session). The directory
 *     is created lazily on first `appendEntries`, so reads never need
 *     to mkdir.
 *
 * Imports from: node:fs/promises, node:os, node:path, ./types.js.
 * Imported by: session_manager.ts.
 */

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { type ChatHistoryEntry, chatHistoryEntrySchema } from './types.js';

// ---------------------------------------------------------------------------
// Constants (top-of-file for ops visibility)
// ---------------------------------------------------------------------------

const SESSIONS_SUBDIR = 'agent-bridge/sessions';

const noopWarn: (message: string) => void = () => {
  /* default sink */
};

// ---------------------------------------------------------------------------
// Slug encoding
// ---------------------------------------------------------------------------

/**
 * Filesystem-safe encoding of a session slug. Pure function (no I/O) so it
 * can be reused by the session manager + tests for deterministic asserts.
 */
export function encodeSessionSlug(slug: string): string {
  // First, encode `:` → `__` so the canonical separator survives identifiably.
  const colonReplaced = slug.split(':').join('__');
  // Then, scrub anything else outside [A-Za-z0-9_-].
  return colonReplaced.replace(/[^A-Za-z0-9_-]/g, '_');
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface SessionPersistenceOptions {
  /** Override the sessions root (default: `~/.opensquid/agent-bridge/sessions`). */
  root?: string;
  /** Structured warn sink for malformed rows. */
  onWarn?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// SessionPersistence
// ---------------------------------------------------------------------------

export class SessionPersistence {
  private readonly root: string;
  private readonly warn: (message: string) => void;
  /** Tracks which session dirs we have already ensured exist (avoids
   *  redundant mkdir syscalls on the hot append path). */
  private readonly dirsEnsured = new Set<string>();

  constructor(opts: SessionPersistenceOptions = {}) {
    this.root = opts.root ?? join(homedir(), '.opensquid', SESSIONS_SUBDIR);
    this.warn = opts.onWarn ?? noopWarn;
  }

  /**
   * Resolve the absolute file path for a session. Exposed for tests +
   * the session manager's eviction-flush callback diagnostics.
   */
  pathFor(slug: string): string {
    return join(this.root, `${encodeSessionSlug(slug)}.jsonl`);
  }

  /**
   * Read all history entries for a session, in append order. Missing file
   * → empty array (fresh session). Malformed / schema-mismatched rows are
   * skipped + warned; valid rows are still returned. Non-streaming: history
   * is bounded by LRU cap × N turns and the agent loop needs the full array.
   */
  async loadHistory(slug: string): Promise<ChatHistoryEntry[]> {
    const path = this.pathFor(slug);
    let raw: string;
    try {
      raw = await fs.readFile(path, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return [];
      this.warn(
        `[agent_bridge.persistence] read failed ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
    const entries: ChatHistoryEntry[] = [];
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i];
      if (rawLine === undefined) continue;
      const line = rawLine.trim();
      if (line === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        this.warn(
          `[agent_bridge.persistence] malformed JSON at ${path}:${i + 1}: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      const result = chatHistoryEntrySchema.safeParse(parsed);
      if (!result.success) {
        this.warn(
          `[agent_bridge.persistence] schema mismatch at ${path}:${i + 1}: ${result.error.message}`,
        );
        continue;
      }
      entries.push(result.data);
    }
    return entries;
  }

  /**
   * Append history entries to the session's JSONL. Uses `fs.appendFile`
   * (which opens with `O_APPEND`) so concurrent writers serialize at the
   * kernel level for sub-PIPE_BUF rows. Per-line `\n` framing tolerates
   * the (extremely rare) case of an interleaved >4KB row.
   *
   * Atomic-or-throw contract: either the whole batch of entries is
   * appended, or this method throws and the caller's state should not
   * advance. We build one string + one syscall to keep the atomicity
   * boundary at "all or nothing" for the typical small batch.
   */
  async appendEntries(slug: string, entries: ChatHistoryEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await this.ensureDir();
    const path = this.pathFor(slug);
    // Strip the in-memory-only `cacheMark` hint before serializing — it is
    // recomputed per-turn by the agent loop from history positions and
    // would otherwise pollute the on-disk shape.
    const lines = entries.map((entry) => JSON.stringify(stripCacheMark(entry)));
    const payload = `${lines.join('\n')}\n`;
    await fs.appendFile(path, payload, 'utf8');
  }

  /** Lazy mkdir guarded by an in-memory set — keeps repeat appends cheap. */
  private async ensureDir(): Promise<void> {
    if (this.dirsEnsured.has(this.root)) return;
    await fs.mkdir(this.root, { recursive: true });
    this.dirsEnsured.add(this.root);
  }
}

/** Drop the in-memory-only `cacheMark` field. Returns a new object. */
function stripCacheMark(entry: ChatHistoryEntry): Omit<ChatHistoryEntry, 'cacheMark'> {
  const rest: Omit<ChatHistoryEntry, 'cacheMark'> = {
    role: entry.role,
    content: entry.content,
    timestamp: entry.timestamp,
  };
  return rest;
}
