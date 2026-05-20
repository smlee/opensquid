/**
 * Restart-safe resume of interrupted runs (DURABLE.4).
 *
 * Daemon boot fires `resumeOnStartup()` AFTER lock acquire + BEFORE cron
 * registration. Scans the checkpoint store for runs that have a
 * manifest, no terminal marker, and a last-completed step within the
 * resume window. For each, resolves the rule's current `ProcessStep[]`
 * (via caller-supplied `RuleResolver`), hydrates `as:` bindings, and
 * re-invokes the caller-supplied `RunEvaluator` from the next step.
 *
 * Locks (DURABLE.4 §learn / §risk):
 *   - Window default 60s; `OPENSQUID_RESUME_WINDOW_MS` env override.
 *     Explicit `opensquid checkpoints resume <run_id>` bypasses window.
 *   - Pack-version mismatch → skip + audit `pack_version_mismatch`.
 *     No silent migration (rules may have changed shape).
 *   - Audit posture: ONE summary entry per startup call; per-run
 *     entries only for resumed + reason-worthy skips. Stale-window
 *     runs are filtered at SQL level, never enumerated.
 *   - Concurrent-execution race avoided by daemon's proper-lockfile
 *     singleton (SCHED.1); Resumer holds no lock of its own.
 *
 * Terminal-marker choice: Option 2 (explicit `terminal_markers` table)
 * — cheaper than reloading every pack at scan time to compute
 * `lastCompletedStep === totalSteps - 1`.
 *
 * Imports from: ./checkpoint_store.js, ../types.js.
 * Imported by: OpenSquidDaemon (DURABLE.4 wire), checkpoints CLI.
 */

import type { CheckpointStore, InterruptedSummary, RunManifest } from './checkpoint_store.js';
import type { ProcessStep } from '../types.js';

/** 60s — long enough for fast restart, short enough to avoid ghost revives. */
export const DEFAULT_RESUME_WINDOW_MS = 60_000;

/** Resolver: manifest → current `ProcessStep[]` + live `packVersion`, or `null`
 *  when the pack/skill/rule no longer exists. Drives `pack_missing` skip. */
export interface ResolvedRule {
  process: ProcessStep[];
  packVersion: string;
}

export type RuleResolver = (manifest: RunManifest) => Promise<ResolvedRule | null>;

/** Caller-supplied evaluator entry. Resumer never imports `evaluateProcess`
 *  directly — keeps the module dependency-light and stubbable in tests. */
export interface RunEvaluatorInput {
  manifest: RunManifest;
  bindings: Record<string, unknown>;
  entryStepIdx: number;
}

export type RunEvaluator = (input: RunEvaluatorInput) => Promise<void>;

/** Joined view of an interrupted run — manifest + checkpoint cursor. */
export interface InterruptedRun {
  runId: string;
  lastCompletedStep: number;
  lastCompletedAtMs: number;
  packId: string;
  packVersion: string;
  skill: string;
  ruleId: string;
  eventKind: string;
  eventPayload: unknown;
}

/** Audit entry shapes. `resume_summary` fires once per startup;
 *  `resume_run` / `resume_skipped` ride along per run. */
export type SkipReason =
  | 'manifest_missing'
  | 'pack_missing'
  | 'rule_missing'
  | 'pack_version_mismatch'
  | 'evaluator_error';

export type AuditEntry =
  | { event: 'resume_summary'; scanned: number; resumed: number; skippedOther: number }
  | { event: 'resume_run'; runId: string; packId: string; fromStepIdx: number }
  | { event: 'resume_skipped'; runId: string; reason: SkipReason; detail?: string };

export type AuditSink = (entry: AuditEntry) => void;

const noopAudit: AuditSink = () => {
  /* default audit sink */
};

export interface ResumeOpts {
  store: CheckpointStore;
  evaluator: RunEvaluator;
  resolver: RuleResolver;
  /** Audit sink; default no-op. */
  auditLog?: AuditSink;
  /** Override the default resume window. `Number.POSITIVE_INFINITY` disables. */
  resumeWindowMs?: number;
  /** Injected clock for tests; defaults to `Date.now`. */
  nowMs?: () => number;
}

export interface ResumeResult {
  resumed: boolean;
  reason?: SkipReason;
}

export interface ResumeStartupResult {
  resumed: number;
  skipped: number;
}

export class Resumer {
  private readonly store: CheckpointStore;
  private readonly evaluator: RunEvaluator;
  private readonly resolver: RuleResolver;
  private readonly auditLog: AuditSink;
  private readonly resumeWindowMs: number;
  private readonly nowMs: () => number;

  constructor(opts: ResumeOpts) {
    this.store = opts.store;
    this.evaluator = opts.evaluator;
    this.resolver = opts.resolver;
    this.auditLog = opts.auditLog ?? noopAudit;
    this.resumeWindowMs =
      opts.resumeWindowMs ?? readResumeWindowFromEnv() ?? DEFAULT_RESUME_WINDOW_MS;
    this.nowMs = opts.nowMs ?? Date.now;
  }

  /** Discover interrupted runs in the configured resume window. */
  async scanInterrupted(): Promise<InterruptedRun[]> {
    const summaries = await this.store.scanInterrupted(this.resumeWindowMs, this.nowMs());
    return this.joinManifests(summaries);
  }

  /** Resume one interrupted run. Returns `{ resumed: false, reason }` on
   *  any skip (pack uninstalled, version diverged, evaluator threw). */
  async resume(run: InterruptedRun): Promise<ResumeResult> {
    // Build the manifest shape the resolver expects from the joined view.
    const manifest: RunManifest = {
      runId: run.runId,
      packId: run.packId,
      packVersion: run.packVersion,
      skill: run.skill,
      ruleId: run.ruleId,
      eventKind: run.eventKind,
      eventPayload: run.eventPayload,
      startedAtMs: run.lastCompletedAtMs,
    };
    const resolved = await this.resolver(manifest);
    if (resolved === null) {
      // Resolver returns null when the pack / skill / rule can't be
      // found. Default reason is `pack_missing` (most common cause);
      // the resolver can surface richer detail via its own audit hook.
      this.auditLog({ event: 'resume_skipped', runId: run.runId, reason: 'pack_missing' });
      return { resumed: false, reason: 'pack_missing' };
    }
    if (resolved.packVersion !== run.packVersion) {
      this.auditLog({
        event: 'resume_skipped',
        runId: run.runId,
        reason: 'pack_version_mismatch',
        detail: `was=${run.packVersion} now=${resolved.packVersion}`,
      });
      return { resumed: false, reason: 'pack_version_mismatch' };
    }
    const bindings = await this.store.loadBindings(run.runId);
    const entryStepIdx = run.lastCompletedStep + 1;
    try {
      await this.evaluator({ manifest, bindings, entryStepIdx });
    } catch (err) {
      this.auditLog({
        event: 'resume_skipped',
        runId: run.runId,
        reason: 'evaluator_error',
        detail: err instanceof Error ? err.message : String(err),
      });
      return { resumed: false, reason: 'evaluator_error' };
    }
    this.auditLog({
      event: 'resume_run',
      runId: run.runId,
      packId: run.packId,
      fromStepIdx: entryStepIdx,
    });
    return { resumed: true };
  }

  /** Daemon-startup entrypoint: scan + resume all. Invoked AFTER lock
   *  acquire + BEFORE cron registration so resumes finish before fresh
   *  fires can race. One summary audit entry; per-run only for resumed +
   *  reason-worthy skips. */
  async resumeOnStartup(): Promise<ResumeStartupResult> {
    const interrupted = await this.scanInterrupted();
    let resumed = 0;
    let skippedOther = 0;
    for (const run of interrupted) {
      const r = await this.resume(run);
      if (r.resumed) resumed += 1;
      else skippedOther += 1;
    }
    this.auditLog({
      event: 'resume_summary',
      scanned: interrupted.length,
      resumed,
      skippedOther,
    });
    return { resumed, skipped: skippedOther };
  }

  private async joinManifests(summaries: InterruptedSummary[]): Promise<InterruptedRun[]> {
    const out: InterruptedRun[] = [];
    for (const s of summaries) {
      const m = await this.store.getRunManifest(s.runId);
      if (!m) {
        // Orphan checkpoint: rule dispatcher forgot `recordRunStart`.
        // Programmer error, not a normal recovery path → always audit.
        this.auditLog({ event: 'resume_skipped', runId: s.runId, reason: 'manifest_missing' });
        continue;
      }
      out.push({
        runId: m.runId,
        lastCompletedStep: s.lastCompletedStep,
        lastCompletedAtMs: s.lastCompletedAtMs,
        packId: m.packId,
        packVersion: m.packVersion,
        skill: m.skill,
        ruleId: m.ruleId,
        eventKind: m.eventKind,
        eventPayload: m.eventPayload,
      });
    }
    return out;
  }
}

function readResumeWindowFromEnv(): number | undefined {
  const raw = process.env.OPENSQUID_RESUME_WINDOW_MS;
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}
