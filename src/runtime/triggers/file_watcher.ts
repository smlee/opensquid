/**
 * `FileWatcher` — chokidar-backed file-change trigger source (AUTO.5).
 *
 * Authoritative source: `docs/tasks/automation.md` AUTO.5. Watches the glob
 * paths a skill declares in `triggers: [{kind: 'file_changed', paths: [...]}]`
 * and emits `FileChangedEvent` into the runtime evaluator.
 *
 * Per-skill granularity (mirrors `ScheduleEntry`): one watcher per skill
 * that declares a `file_changed` trigger. 50 packs × 5 watchers ≈ 250
 * instances; acceptable for v1 per spec risk callout.
 *
 * Locked behaviors (spec):
 *   - Debounce 200ms per `(changeKind, path)` — collapses editor write
 *     bursts WITHOUT merging unlink+add (rename) into one event.
 *   - `awaitWriteFinish` {stabilityThreshold: 100, pollInterval: 50} —
 *     suppresses partial-write events (atomic save / IDE auto-save).
 *   - Default `ignored`: `['**\/node_modules/**', '**\/.git/**']`.
 *   - Rate-limit gate (AUTO.2): `rateLimiter.check(pack, 'file_changed',
 *     path)` runs BEFORE every dispatch; denial drops + audits.
 *     `release()` is the evaluator's job (out of scope for AUTO.5).
 *
 * Fail-closed (constraint C10): `dispatch` errors + chokidar backend
 * errors audit as `file_changed_error`. No silent swallows.
 *
 * Lifecycle:
 *   - `start()` opens chokidar with `ignoreInitial: true` so existing
 *     files don't generate startup `add` events. Listeners attach for
 *     `add` / `change` / `unlink` / `error`.
 *   - `stop()` awaits `watcher.close()` and clears every pending debounce
 *     timer. After `stop()` resolves, no further dispatch can race in.
 *     Idempotent; restart after stop throws (programmer error).
 *
 * Engine-vocabulary: returns `(pack, skill, path)` + `FileChangedEvent`.
 * No consumer-product names leak into this module.
 *
 * Imports from: chokidar, ../event.js, ../rate_limit.js.
 * Imported by: ./index.ts (registry barrel) + the daemon.
 */

import { type FSWatcher, watch } from 'chokidar';

import type { FileChangedEvent } from '../event.js';
import type { RateLimiter } from '../rate_limit.js';

export interface FileWatcherConfig {
  /** Pack identifier — passed to the rate limiter + audit sink. */
  pack: string;
  /** Skill identifier — included in audit entries for provenance. */
  skill: string;
  /** Glob paths from `skill.triggers[].paths`. */
  paths: string[];
  /** Glob paths to exclude. Defaults to node_modules + .git below. */
  ignored?: string[];
  /** Per-`(kind, path)` debounce window. Defaults to 200ms (spec). */
  debounceMs?: number;
  /** Test seam — usePolling forces chokidar's polling backend (CI / Docker). */
  usePolling?: boolean;
}

type ChangeKind = 'add' | 'change' | 'unlink';
interface AuditCommon {
  pack: string;
  skill: string;
  path: string;
}
export type FileWatcherAuditEntry =
  | (AuditCommon & { event: 'file_changed_dispatched'; changeKind: ChangeKind })
  | (AuditCommon & { event: 'file_changed_rate_limited'; changeKind: ChangeKind; reason?: string })
  | (AuditCommon & { event: 'file_changed_error'; reason: string });

export type FileWatcherAuditSink = (entry: FileWatcherAuditEntry) => void;

const DEFAULT_DEBOUNCE_MS = 200;
const DEFAULT_IGNORED: readonly string[] = Object.freeze(['**/node_modules/**', '**/.git/**']);
const DEFAULT_STABILITY_THRESHOLD_MS = 100;
const DEFAULT_POLL_INTERVAL_MS = 50;

const noopAudit: FileWatcherAuditSink = () => {
  /* default audit sink */
};

export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>();
  private readonly auditLog: FileWatcherAuditSink;
  private readonly debounceMs: number;
  private readonly nowFn: () => number;
  private stopped = false;

  constructor(
    private readonly cfg: FileWatcherConfig,
    private readonly dispatch: (event: FileChangedEvent) => Promise<void>,
    private readonly rateLimiter: RateLimiter,
    opts: { auditLog?: FileWatcherAuditSink; now?: () => number } = {},
  ) {
    this.auditLog = opts.auditLog ?? noopAudit;
    this.debounceMs = cfg.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.nowFn = opts.now ?? Date.now;
  }

  /** Open the chokidar watcher. Second `start()` or restart-after-stop
   *  throws — the daemon owns lifecycle, so a re-call indicates a bug. */
  start(): void {
    if (this.watcher !== null) {
      throw new Error(
        `FileWatcher.start: already started for pack "${this.cfg.pack}" skill "${this.cfg.skill}"`,
      );
    }
    if (this.stopped) {
      throw new Error(
        `FileWatcher.start: cannot restart a stopped watcher (pack "${this.cfg.pack}" skill "${this.cfg.skill}")`,
      );
    }

    this.watcher = watch(this.cfg.paths, {
      ignored: this.cfg.ignored ?? [...DEFAULT_IGNORED],
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: DEFAULT_STABILITY_THRESHOLD_MS,
        pollInterval: DEFAULT_POLL_INTERVAL_MS,
      },
      ...(this.cfg.usePolling !== undefined ? { usePolling: this.cfg.usePolling } : {}),
    });

    this.watcher.on('add', (path) => {
      this.debounceEmit('add', path);
    });
    this.watcher.on('change', (path) => {
      this.debounceEmit('change', path);
    });
    this.watcher.on('unlink', (path) => {
      this.debounceEmit('unlink', path);
    });
    this.watcher.on('error', (err) => {
      // chokidar surfaces backend errors (e.g. EPERM on a watched directory)
      // through this channel. Fail-loud: audit so the operator notices; do
      // NOT close the watcher (chokidar can recover from transient errors).
      this.auditLog({
        event: 'file_changed_error',
        pack: this.cfg.pack,
        skill: this.cfg.skill,
        path: '<watcher-error>',
        reason: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /**
   * Tear down the chokidar instance and clear every pending debounce
   * timer. Safe to call multiple times — second call is a no-op.
   */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    // Clear every pending debounce timer first so an in-flight 200ms
    // tail can't race past `watcher.close()`.
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    const w = this.watcher;
    this.watcher = null;
    if (w !== null) {
      await w.close();
    }
  }

  /** Debounce per `(kind, path)`. Public for test introspection only. */
  private debounceEmit(changeKind: FileChangedEvent['changeKind'], path: string): void {
    if (this.stopped) return;

    const key = `${changeKind}::${path}`;
    const existing = this.debounceTimers.get(key);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.debounceTimers.delete(key);
      void this.fireAfterDebounce(changeKind, path);
    }, this.debounceMs);
    // Don't keep the event loop alive on the timer (matches node-cron's
    // posture) — the daemon owns the process lifecycle.
    timer.unref?.();
    this.debounceTimers.set(key, timer);
  }

  private async fireAfterDebounce(
    changeKind: FileChangedEvent['changeKind'],
    path: string,
  ): Promise<void> {
    if (this.stopped) return;

    // Rate-limit BEFORE dispatch. The limiter's `check()` is unconfigured-
    // pack-aware (returns allowed: true for packs that didn't declare
    // file_changed limits), so this is safe for unrestricted packs too.
    let decision;
    try {
      decision = await this.rateLimiter.check(this.cfg.pack, 'file_changed', path);
    } catch (err) {
      this.auditLog({
        event: 'file_changed_error',
        pack: this.cfg.pack,
        skill: this.cfg.skill,
        path,
        reason: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (!decision.allowed) {
      const entry: FileWatcherAuditEntry = {
        event: 'file_changed_rate_limited',
        pack: this.cfg.pack,
        skill: this.cfg.skill,
        path,
        changeKind,
      };
      if (decision.reason !== undefined) entry.reason = decision.reason;
      this.auditLog(entry);
      return;
    }

    const event: FileChangedEvent = {
      kind: 'file_changed',
      path,
      changeKind,
      changedAt: new Date(this.nowFn()).toISOString(),
    };

    try {
      await this.dispatch(event);
      this.auditLog({
        event: 'file_changed_dispatched',
        pack: this.cfg.pack,
        skill: this.cfg.skill,
        path,
        changeKind,
      });
    } catch (err) {
      this.auditLog({
        event: 'file_changed_error',
        pack: this.cfg.pack,
        skill: this.cfg.skill,
        path,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
