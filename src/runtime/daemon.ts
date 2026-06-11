/**
 * `OpenSquidDaemon` — unified background process for every inbound trigger
 * source that doesn't ride on a host tool-call hook. Source: SCHED.1.
 *
 * Scope: node-cron schedules + HMAC webhook intake + singleton via
 * proper-lockfile. AUTO.5 file watchers and AUTO.6 inbound channels plug
 * into the same lifecycle later without changing the public surface.
 *
 * `start()` atomic: validate cron, acquire lock, register tasks, bind
 * webhook server, write pid file. Rollback on failure so the next start
 * never trips over partial state. `stop()` strict-order: cron tasks →
 * webhook server → pid file → lock release. Each step best-effort; only
 * the lock release is irrecoverable. Signals (SIGTERM/SIGINT) fire stop()
 * exactly once.
 *
 * Singleton via `proper-lockfile.lock(daemonLockPath(), { retries: 0,
 * realpath: false })`. `realpath: false` so the target need not exist;
 * `retries: 0` fails fast on contention. Engine-vocabulary: no consumer
 * product names — consumers wire their own `dispatch` callback.
 *
 * Imported by: src/cli.ts (daemon CLI), runtime tests.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createClient, type Client } from '@libsql/client';
import cron from 'node-cron';
import { lock as acquireLock } from 'proper-lockfile';

import type { NotificationRouter } from '../channels/router.js';
import type { RoutingConfig } from '../channels/types.js';

import { adaptResumer, adaptWebhookServer } from './audit_adapters.js';
import { AuditLog } from './audit_log.js';
import { handleDeliverOnly } from './deliver_only.js';
import type { Resumer, ResumeAuditEntry } from './durable/index.js';
import type { Event, FileChangedEvent, ScheduleEvent, WebhookEvent } from './event.js';
import { daemonLockPath, daemonPidPath, OPENSQUID_HOME } from './paths.js';
import type { RateLimiter } from './rate_limit.js';
import { buildScheduleRegistry, type ScheduleEntry } from './schedule_registry.js';
import {
  FileWatcher,
  type FileWatcherAuditEntry,
  type FileWatcherConfig,
} from './triggers/index.js';
import type { Pack } from './types.js';
import {
  WebhookServer,
  type DeliverOnlyHandler,
  type WebhookAuditEntry,
  type WebhookAuditSink,
} from './webhook_server.js';
import type { Subscription } from './webhook_subscriptions.js';

/** Caller routes `ScheduleEvent` + `WebhookEvent` into the runtime
 * evaluator. The daemon doesn't import the evaluator directly — keeps
 * this module dependency-light AND lets tests dispatch into a stub. */
export type DaemonDispatcher = (event: Event) => Promise<void>;

export type DaemonAuditEntry =
  | { event: 'schedule_fired'; entryId: string; fireTime: string }
  | { event: 'schedule_rate_limited'; entryId: string; fireTime: string }
  | { event: 'schedule_error'; entryId: string; reason: string; fireTime: string }
  | { event: 'webhook'; payload: Parameters<WebhookAuditSink>[0] }
  | { event: 'file_changed'; payload: FileWatcherAuditEntry }
  | { event: 'lifecycle'; phase: 'start' | 'stop' | 'sigterm' | 'sigint'; at: string }
  | { event: 'resume'; payload: ResumeAuditEntry };

export type DaemonAuditSink = (entry: DaemonAuditEntry) => void;

export interface DaemonOpts {
  /** Daemon walks `pack.skills[].triggers[]` for schedule entries. */
  packs: readonly Pack[];
  /** Resolved + secret-bearing subscription list (see webhook_subscriptions.ts). */
  subscriptions: readonly Subscription[];
  dispatch: DaemonDispatcher;
  /** Webhook port. Default 8765. */
  webhookPort?: number;
  webhookHost?: string;
  /** Rate-limiter (AUTO.2). Applied per-fire on cron + per-request on webhook. */
  rateLimiter?: RateLimiter;
  /** SCHED.2 — router + config used for `deliverOnly: true` subscriptions.
   *  Optional: a daemon with no deliver-only subscriptions doesn't need
   *  either field. If a deliver-only sub fires without these set, the
   *  webhook server returns 200 + audits as `misconfigured`. */
  notificationRouter?: NotificationRouter;
  routingConfig?: RoutingConfig;
  auditLog?: DaemonAuditSink;
  /** DURABLE.4 — restart-safe resume hook. When set, `start()` invokes
   *  `resumer.resumeOnStartup()` AFTER lock acquire + BEFORE cron tasks
   *  register so interrupted runs replay before fresh fires race. The
   *  resumer's own audit entries are surfaced via the daemon audit sink
   *  under the `resume` event variant. Optional — daemons without a
   *  checkpoint store don't need it. */
  resumer?: Resumer;
  /** Patch C — optional injected libsql client backing the unified
   *  `AuditLog`. When omitted, the daemon opens its own
   *  `file:${OPENSQUID_HOME}/opensquid.db` client during `start()` and
   *  closes it during `stop()`. Tests inject a `createClient({ url:
   *  ':memory:' })` here. Caller-provided clients are NEVER closed by the
   *  daemon — caller-owned lifecycle. */
  auditClient?: Client;
  /** Injected clock — tests pass a fake. */
  now?: () => number;
}

const DEFAULT_WEBHOOK_PORT = 8765;

const noopAudit: DaemonAuditSink = () => {
  /* default audit sink (named to satisfy eslint no-empty-function) */
};

export class OpenSquidDaemon {
  private readonly opts: DaemonOpts;
  private readonly auditLog: DaemonAuditSink;
  private readonly nowFn: () => number;
  private readonly tasks = new Map<string, cron.ScheduledTask>();
  private readonly entries = new Map<string, ScheduleEntry>();
  private readonly fileWatchers = new Map<string, FileWatcher>();
  private webhookServer: WebhookServer | null = null;
  private release: (() => Promise<void>) | null = null;
  private state: 'idle' | 'starting' | 'running' | 'stopping' | 'stopped' = 'idle';
  private startedAtMs: number | null = null;
  private signalHandlers: { signal: NodeJS.Signals; handler: () => void }[] = [];
  /** Patch C — unified `audit_log` table sink. Opened in `start()` after
   *  the proper-lockfile acquire; closed in `stop()` AFTER producers
   *  drain so final shutdown writes still land. `null` outside the
   *  running window — `getAuditLog()` enforces that contract. */
  private auditLogInstance: AuditLog | null = null;
  private auditClient: Client | null = null;
  /** `true` when the daemon opened its own libsql client; `false` when
   *  the caller injected one. Gates the close-on-stop path. */
  private auditClientOwned = false;

  constructor(opts: DaemonOpts) {
    this.opts = opts;
    this.auditLog = opts.auditLog ?? noopAudit;
    this.nowFn = opts.now ?? Date.now;
  }

  /** Atomic start. Rolls back on any failure. */
  async start(): Promise<void> {
    if (this.state !== 'idle') {
      throw new Error(`OpenSquidDaemon.start: invalid state "${this.state}"`);
    }
    this.state = 'starting';

    // Validate cron before acquiring the lock so a bad pack never touches it.
    const entries = buildScheduleRegistry(this.opts.packs);

    // proper-lockfile needs the parent dir before mkdir-ing `.lock`.
    await mkdir(OPENSQUID_HOME(), { recursive: true });

    // Singleton: `realpath: false` lets the target not exist; `retries: 0`
    // fails fast on contention.
    try {
      this.release = await acquireLock(daemonLockPath(), { retries: 0, realpath: false });
    } catch (err) {
      this.state = 'idle';
      throw new Error(
        `OpenSquidDaemon.start: another daemon is already running (lock at ${daemonLockPath()}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    try {
      // Patch C — open the unified `AuditLog` immediately after the lock
      // acquire so every producer constructed below (WebhookServer,
      // Resumer fan-out) routes into it from the first event. Init is
      // idempotent DDL; failures bubble through the existing rollback.
      // Caller-injected client is NOT closed by the daemon — the caller
      // owns lifecycle when they pass one in (the `auditClientOwned`
      // flag below gates close-on-stop).
      if (this.opts.auditClient !== undefined) {
        this.auditClient = this.opts.auditClient;
        this.auditClientOwned = false;
      } else {
        this.auditClient = createClient({ url: `file:${join(OPENSQUID_HOME(), 'opensquid.db')}` });
        this.auditClientOwned = true;
      }
      this.auditLogInstance = new AuditLog(this.auditClient);
      await this.auditLogInstance.init();

      // Patch C — fan-out resumer events into the unified AuditLog.
      // Resumer is constructed by the caller (the daemon receives it
      // pre-built), so we attach an additional sink rather than rewiring
      // construction. Caller's primary audit sink stays untouched; the
      // attached `adaptResumer` sink fires after it. Guarded for legacy
      // / stub resumers that pre-date the `attachAuditSink` API — those
      // still work, just without unified-table fan-out.
      if (this.opts.resumer !== undefined) {
        const attach = (
          this.opts.resumer as unknown as {
            attachAuditSink?: (sink: ReturnType<typeof adaptResumer>) => void;
          }
        ).attachAuditSink;
        if (typeof attach === 'function') {
          attach.call(this.opts.resumer, adaptResumer(this.auditLogInstance, this.nowFn));
        }
      }

      // DURABLE.4 — replay any interrupted runs BEFORE registering cron
      // tasks. The order matters: a cron tick that races a resume could
      // double-execute the same run. Singleton lock above already
      // guarantees we're the only daemon doing this. Resumer failures
      // bubble up via the same rollback path as cron / webhook failures.
      if (this.opts.resumer !== undefined) {
        await this.opts.resumer.resumeOnStartup();
      }

      // Cron tasks wrap user code in fireScheduleEntry's try/catch so a
      // rule-side throw never crashes the cron loop.
      for (const entry of entries) {
        this.entries.set(entry.id, entry);
        const task = cron.schedule(
          entry.cron,
          () => {
            void this.fireScheduleEntry(entry);
          },
          { scheduled: true, timezone: entry.timezone },
        );
        this.tasks.set(entry.id, task);
      }

      // Patch C — webhook events fan out to BOTH the caller-supplied
      // `DaemonAuditSink` (existing `{ event: 'webhook', payload }`
      // contract) AND the unified `AuditLog` via `adaptWebhookServer`.
      // Tee'd sink so callers depending on the daemon's audit callback
      // (existing tests) keep working while the libsql `audit_log` table
      // gets populated.
      const unifiedWebhookSink: WebhookAuditSink = adaptWebhookServer(
        this.auditLogInstance,
        this.nowFn,
      );
      const teeWebhookSink: WebhookAuditSink = (payload: WebhookAuditEntry): void => {
        this.auditLog({ event: 'webhook', payload });
        unifiedWebhookSink(payload);
      };
      const deliverOnlyHandler = this.buildDeliverOnlyHandler();
      this.webhookServer = new WebhookServer({
        port: this.opts.webhookPort ?? DEFAULT_WEBHOOK_PORT,
        ...(this.opts.webhookHost !== undefined ? { host: this.opts.webhookHost } : {}),
        subscriptions: this.opts.subscriptions,
        dispatch: (event: WebhookEvent) => this.opts.dispatch(event),
        ...(deliverOnlyHandler !== undefined ? { deliverOnly: deliverOnlyHandler } : {}),
        ...(this.opts.rateLimiter !== undefined ? { rateLimiter: this.opts.rateLimiter } : {}),
        auditLog: teeWebhookSink,
        now: this.nowFn,
      });
      await this.webhookServer.start();

      // AUTO.5 — file-change trigger sources. One watcher per skill that
      // declares a `file_changed` trigger; constructed lazy so packs with
      // no file_changed triggers never instantiate chokidar.
      this.startFileWatchers();

      // Pid file is best-effort; not load-bearing for correctness.
      await writeFile(daemonPidPath(), String(process.pid), 'utf8');
      this.installSignalHandlers();

      this.startedAtMs = this.nowFn();
      this.state = 'running';
      this.auditLog({
        event: 'lifecycle',
        phase: 'start',
        at: new Date(this.startedAtMs).toISOString(),
      });
    } catch (err) {
      // Rollback in reverse order.
      await this.rollbackStart();
      this.state = 'idle';
      throw err;
    }
  }

  /** Strict order: cron tasks → webhook server → pid file → lock release.
   * Each step is best-effort; only the lock release matters for the next
   * start. proper-lockfile also clears its own state on process exit via
   * signal-exit, so a missed release here doesn't permanently brick. */
  async stop(): Promise<void> {
    if (this.state === 'stopped' || this.state === 'idle') return;
    this.state = 'stopping';

    for (const task of this.tasks.values()) safeSync(() => task.stop());
    this.tasks.clear();
    this.entries.clear();

    // AUTO.5 — close file watchers first so an in-flight chokidar event
    // can't sneak past the dispatcher after `stop()` returns.
    for (const watcher of this.fileWatchers.values()) {
      await safeAsync(() => watcher.stop());
    }
    this.fileWatchers.clear();

    if (this.webhookServer) {
      await safeAsync(() => this.webhookServer?.close() ?? Promise.resolve());
      this.webhookServer = null;
    }

    // Patch C — emit the `lifecycle: stop` audit BEFORE closing the
    // libsql client so any unified-AuditLog subscriber to lifecycle
    // events still records it. (Today the daemon's `auditLog` callback
    // never re-routes lifecycle events into the unified table — it's a
    // future hook; emitting here keeps both ordering options open.)
    this.startedAtMs = null;
    this.auditLog({
      event: 'lifecycle',
      phase: 'stop',
      at: new Date(this.nowFn()).toISOString(),
    });

    // Patch C — close the AuditLog libsql client AFTER all producers
    // stopped. `close()` is idempotent in @libsql/client; we still gate
    // on `auditClientOwned` so caller-injected clients are untouched.
    this.closeAuditClient();

    await safeAsync(() => rm(daemonPidPath(), { force: true }));

    if (this.release) {
      await safeAsync(this.release);
      this.release = null;
    }

    this.uninstallSignalHandlers();

    this.state = 'stopped';
  }

  /** Patch C — public accessor for the daemon's unified `AuditLog`.
   *  Returns `null` outside the running window (before `start()`
   *  completes, after `stop()`, or while a `start()` rollback ran).
   *  Callers who construct their OWN producers (e.g. `InboundRouter`)
   *  fetch this AFTER `await daemon.start()` and wire `adaptInboundRouter
   *  (daemon.getAuditLog()!)` themselves. */
  getAuditLog(): AuditLog | null {
    return this.auditLogInstance;
  }

  /** Internal — closes the libsql client iff the daemon opened it. Safe
   *  to call multiple times. Always clears the field references so a
   *  follow-up `start()` re-opens fresh. */
  private closeAuditClient(): void {
    if (this.auditClient !== null && this.auditClientOwned) {
      safeSync(() => this.auditClient?.close());
    }
    this.auditClient = null;
    this.auditClientOwned = false;
    this.auditLogInstance = null;
  }

  /** PID-aware status read used by the `daemon status` CLI verb. */
  async status(): Promise<DaemonStatus> {
    if (this.state === 'running' && this.startedAtMs !== null) {
      return {
        running: true,
        pid: process.pid,
        uptimeMs: this.nowFn() - this.startedAtMs,
        scheduleCount: this.entries.size,
        webhookPort: this.webhookServer?.address()?.port ?? null,
      };
    }
    // External CLI call — read the pid file if present.
    try {
      const raw = await readFile(daemonPidPath(), 'utf8');
      const pid = Number.parseInt(raw.trim(), 10);
      if (Number.isFinite(pid) && pid > 0) {
        return { running: true, pid, uptimeMs: null, scheduleCount: null, webhookPort: null };
      }
    } catch {
      /* not running */
    }
    return { running: false };
  }

  /** Caller-visible registry — read-only snapshot of entries. */
  scheduleEntries(): readonly ScheduleEntry[] {
    return [...this.entries.values()];
  }

  /** Webhook port — `null` until `start()` returns. */
  webhookBoundPort(): number | null {
    return this.webhookServer?.address()?.port ?? null;
  }

  /** Test seam: synchronously fire one entry's path without advancing the
   * cron tick. Lives on the class (not the test file) because it touches
   * the private `entries` map. Production callers never use this. */
  async fireEntryForTest(entryId: string): Promise<void> {
    const entry = this.entries.get(entryId);
    if (!entry) throw new Error(`fireEntryForTest: unknown entry "${entryId}"`);
    await this.fireScheduleEntry(entry);
  }

  // -------------------------------------------------------------------------
  // Internals.

  /** Build the deliver-only handler closure passed to the webhook server.
   *  Returns `undefined` when no router/config is wired — that case is
   *  handled by the server (audits as `misconfigured`, returns 200). */
  private buildDeliverOnlyHandler(): DeliverOnlyHandler | undefined {
    const router = this.opts.notificationRouter;
    const routing = this.opts.routingConfig;
    if (router === undefined || routing === undefined) return undefined;
    return async (sub: Subscription, body: unknown) => {
      const result = await handleDeliverOnly(sub, body, router, routing);
      return {
        rendered: result.rendered,
        ...(result.reason !== undefined ? { reason: result.reason } : {}),
        emptyFieldCount: result.emptyFieldCount,
        redactedSecrets: result.redactedSecrets,
        ...(result.multicast !== undefined
          ? { multicast: { sent: result.multicast.sent, failed: result.multicast.failed } }
          : {}),
      };
    };
  }

  private async fireScheduleEntry(entry: ScheduleEntry): Promise<void> {
    const fireTime = new Date(this.nowFn()).toISOString();
    // FAC.1: the concurrent slot guards the triggered run — release on
    // every exit after a successful check() (floors at 0; no-op when
    // unconfigured).
    let acquiredSlot = false;
    try {
      if (this.opts.rateLimiter) {
        const decision = await this.opts.rateLimiter.check(entry.pack, 'schedule', entry.id);
        if (!decision.allowed) {
          this.auditLog({ event: 'schedule_rate_limited', entryId: entry.id, fireTime });
          return;
        }
        acquiredSlot = true;
      }
      const event: ScheduleEvent = {
        kind: 'schedule',
        scheduleId: entry.id,
        fireTime,
        triggerPayload: { pack: entry.pack, skill: entry.skill, cron: entry.cron },
      };
      this.auditLog({ event: 'schedule_fired', entryId: entry.id, fireTime });
      await this.opts.dispatch(event);
    } catch (err) {
      this.auditLog({
        event: 'schedule_error',
        entryId: entry.id,
        reason: err instanceof Error ? err.message : String(err),
        fireTime,
      });
    } finally {
      if (acquiredSlot && this.opts.rateLimiter) {
        await this.opts.rateLimiter.release(entry.pack, 'schedule', entry.id);
      }
    }
  }

  private async rollbackStart(): Promise<void> {
    for (const task of this.tasks.values()) safeSync(() => task.stop());
    this.tasks.clear();
    this.entries.clear();
    for (const watcher of this.fileWatchers.values()) {
      await safeAsync(() => watcher.stop());
    }
    this.fileWatchers.clear();
    if (this.webhookServer) {
      await safeAsync(() => this.webhookServer?.close() ?? Promise.resolve());
      this.webhookServer = null;
    }
    // Patch C — release the libsql client opened earlier in start() so
    // a subsequent start() doesn't double-open. Caller-injected clients
    // are left alone (`closeAuditClient` gates on `auditClientOwned`).
    this.closeAuditClient();
    if (this.release) {
      await safeAsync(this.release);
      this.release = null;
    }
    await safeAsync(() => rm(daemonPidPath(), { force: true }));
  }

  /**
   * Walk `packs[].skills[].triggers[]` for `file_changed` triggers and
   * spin up one `FileWatcher` per (pack, skill). Bare config — pack
   * authors declare `paths:` (and optional `ignored:`) on the trigger;
   * everything else (debounce window, awaitWriteFinish thresholds) is
   * driven by the FileWatcher defaults.
   *
   * Skipped silently when a skill has no file_changed triggers (the
   * common case for Phase 1–7 packs). A skill that declares the trigger
   * but omits `paths:` is treated as a YAML mistake by chokidar (it
   * throws at watch-time); we deliberately let that surface inside the
   * `try { ... } catch { rollback }` in `start()` rather than reject at
   * registry-build time, because the YAML-side schema in
   * `runtime/types.ts` allows `paths` to be optional for forward-compat.
   */
  private startFileWatchers(): void {
    if (this.opts.rateLimiter === undefined) {
      // file_changed dispatch depends on the rate limiter (`check()` is
      // unconfigured-pack-aware → unlimited default). We require it
      // wired so the integration is uniform with SCHED.1.
      const hasFileTrigger = this.opts.packs.some((p) =>
        p.skills.some((s) => s.triggers.some((t) => t.kind === 'file_changed')),
      );
      if (hasFileTrigger) {
        throw new Error(
          'OpenSquidDaemon.start: file_changed triggers declared but no rateLimiter wired',
        );
      }
      return;
    }
    const rateLimiter = this.opts.rateLimiter;

    for (const pack of this.opts.packs) {
      for (const skill of pack.skills) {
        let triggerIndex = -1;
        for (const trigger of skill.triggers) {
          triggerIndex += 1;
          if (trigger.kind !== 'file_changed') continue;
          const paths = trigger.paths ?? [];
          if (paths.length === 0) continue; // empty paths = nothing to watch; skip silently

          const id = `${pack.name}::${skill.name}::${triggerIndex}`;
          const cfg: FileWatcherConfig = {
            pack: pack.name,
            skill: skill.name,
            paths: [...paths],
          };
          if (trigger.ignored !== undefined) cfg.ignored = [...trigger.ignored];

          const watcher = new FileWatcher(
            cfg,
            (event: FileChangedEvent) => this.opts.dispatch(event),
            rateLimiter,
            {
              auditLog: (payload) => this.auditLog({ event: 'file_changed', payload }),
              now: this.nowFn,
            },
          );
          watcher.start();
          this.fileWatchers.set(id, watcher);
        }
      }
    }
  }

  private installSignalHandlers(): void {
    const make = (signal: 'sigterm' | 'sigint'): (() => void) => {
      let fired = false;
      return () => {
        if (fired) return;
        fired = true;
        this.auditLog({
          event: 'lifecycle',
          phase: signal,
          at: new Date(this.nowFn()).toISOString(),
        });
        void this.stop();
      };
    };
    const sigterm = make('sigterm');
    const sigint = make('sigint');
    process.on('SIGTERM', sigterm);
    process.on('SIGINT', sigint);
    this.signalHandlers = [
      { signal: 'SIGTERM', handler: sigterm },
      { signal: 'SIGINT', handler: sigint },
    ];
  }

  private uninstallSignalHandlers(): void {
    for (const { signal, handler } of this.signalHandlers) process.off(signal, handler);
    this.signalHandlers = [];
  }
}

// Best-effort exception swallowers — cleanup paths must not throw and
// must not block subsequent cleanup steps.
function safeSync(fn: () => void): void {
  try {
    fn();
  } catch {
    /* best-effort */
  }
}
async function safeAsync(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch {
    /* best-effort */
  }
}

export interface DaemonStatus {
  running: boolean;
  pid?: number;
  uptimeMs?: number | null;
  scheduleCount?: number | null;
  webhookPort?: number | null;
}
