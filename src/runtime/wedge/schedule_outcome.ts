/**
 * Two-stage wedge gate applied to schedule outcomes (SCHED.4).
 *
 * Authoritative source: `docs/tasks/scheduling.md` §"Task SCHED.4" +
 * `docs/opensquid-real-design.md` §"Two-stage wedge gate" + the Phase 7
 * capture/promote pattern (see `./capture.ts` + `./promote.ts`).
 *
 * What this module is:
 *
 *   - A new lesson type, `schedule_outcome`, that captures one (fire, signal)
 *     pair per scheduled run. Each capture is Stage 1 — surfaced to the user
 *     via the same Phase 7.2 buffer (`automation_buffer.ts`) under the
 *     `potential-lessons` category. Nothing auto-promotes from Stage 1.
 *
 *   - A Stage 2 evaluator (`evaluateSchedulePromotion`) that reads the
 *     append-only outcome log and recommends one of three actions based on
 *     EXTERNAL user signals only:
 *       * `promote`             → schedule has earned permanent status.
 *       * `retire`              → schedule is doing harm; user should remove.
 *       * `keep_probationary`   → not enough signal yet.
 *
 *   - A persistence helper (`applyScheduleVerdict`) that gates the status
 *     change behind eviction-immunity: once a schedule is `permanent`, it
 *     cannot auto-retire (matches `feedback_user_authored_lessons_immune`).
 *     The recommend → status transition is intentionally a separate function
 *     so the audit log can record (recommendation, applied?, reason) without
 *     the evaluator making policy calls.
 *
 * Why a separate file (not extending promote.ts):
 *
 *   - `promote.ts` is a PURE function over `OutcomeSignal`. It has no I/O,
 *     no clock, no filesystem. Schedule outcomes are inherently time-series
 *     (N events over the lifetime of a schedule) and need persistence. Mixing
 *     would muddy the audit grep for "no LLM call in promote.ts" — the audit
 *     pattern is module-scoped.
 *
 *   - The new lesson type is additive in `types.ts`; the existing wedge gate
 *     remains untouched. SCHED.4 reuses the Phase 7.2 buffer for Stage 1
 *     capture but owns its own Stage 2 evaluator.
 *
 * Anti-self-grading invariant (the moat):
 *
 *   - This module MUST NOT call an LLM primitive. The decision inputs are
 *     EXTERNAL: `userSignal.kind` ('redo' | 'approve' | 'manual_override').
 *     `redo` is sourced from `full_stop_and_redo` (AUTO.4); `approve` from
 *     the user's buffer walk; `manual_override` from explicit CLI.
 *
 *   - The schedule does NOT promote itself based on its own verdict counts.
 *     `resultKind` (pass/block/warn/surface/error) is recorded for the audit
 *     log but is NOT a promotion input — only the user signal is.
 *
 * Imports from: node:fs/promises, node:path, ../paths, ./automation_buffer,
 *               ./capture, ./types.
 * Imported by: src/runtime/wedge/index.ts, daemon dispatch path (SCHED.1 +
 *              user signal hooks).
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { OPENSQUID_HOME } from '../paths.js';

import { appendBufferEntry } from './automation_buffer.js';

// ---------------------------------------------------------------------------
// ScheduleOutcome — one fire + (optionally) one user signal.
//
// `scheduleId`  — opaque registry id (matches `ScheduleEntry.id` from
//                 SCHED.1). Filename component, so must be filesystem-safe;
//                 callers should sanitize per `paths.ts` rules.
// `runId`       — unique per fire (uuid or `${scheduleId}_${fireTime}`).
//                 Used to dedupe re-captures of the same fire.
// `fireTime`    — ISO 8601 timestamp of the cron tick.
// `durationMs`  — wall-clock ms the dispatched event took to settle.
// `resultKind`  — verdict kind from the evaluator output (audit only — NOT
//                 a promotion input).
// `userSignal`  — OPTIONAL external signal. When absent, this capture is
//                 still recorded (audit log captures every fire) but does
//                 not contribute to approve/redo counts. The buffer walk
//                 is where the user attaches a signal.
// ---------------------------------------------------------------------------

export interface ScheduleOutcome {
  scheduleId: string;
  runId: string;
  fireTime: string;
  durationMs: number;
  resultKind: 'pass' | 'block' | 'warn' | 'surface' | 'error';
  userSignal?:
    | { kind: 'redo'; redoneAt: string }
    | { kind: 'approve'; approvedAt: string }
    | { kind: 'manual_override'; overriddenAt: string; reason: string };
}

// ---------------------------------------------------------------------------
// ScheduleVerdict — Stage 2 recommendation over N runs.
//
// `status`            — CURRENT persisted status (read from disk before
//                       evaluation). New schedules start `probationary`.
// `runCount`          — total signaled fires in the window (approve + redo +
//                       manual_override).
// `approvedCount`     — fires where userSignal.kind === 'approve'.
// `redoCount`         — fires where userSignal.kind === 'redo'.
// `manualOverrideCount` — fires where userSignal.kind === 'manual_override'.
//                       Signal-neutral toward retire BUT blocks promote
//                       (the user stepped in — promotion would be premature).
// `recommend`         — derived from counts + threshold; see decideRecommend.
// ---------------------------------------------------------------------------

export interface ScheduleVerdict {
  scheduleId: string;
  status: 'probationary' | 'permanent' | 'retired';
  runCount: number;
  approvedCount: number;
  redoCount: number;
  manualOverrideCount: number;
  recommend: 'promote' | 'retire' | 'keep_probationary';
}

// ---------------------------------------------------------------------------
// SchedulePromotionThreshold — pack-declared knobs.
//
// `windowN`        — minimum signaled-runs sample size before the evaluator
//                    will emit `promote` (default 5 per spec §"learn"). Too
//                    low = unstable promotions; too high = never promotes.
// `minApproved`    — minimum `approvedCount` within the window (default 4).
// `minRedoRetire`  — minimum `redoCount` that triggers `retire` (default 3).
//                    Independent of `windowN`: 3 redoes is a hard signal
//                    regardless of approve count — the schedule is doing harm.
// ---------------------------------------------------------------------------

export interface SchedulePromotionThreshold {
  windowN: number;
  minApproved: number;
  minRedoRetire: number;
}

export const DEFAULT_SCHEDULE_THRESHOLD: SchedulePromotionThreshold = {
  windowN: 5,
  minApproved: 4,
  minRedoRetire: 3,
};

// ---------------------------------------------------------------------------
// scheduleOutcomeDir — `<OPENSQUID_HOME>/sessions/<id>/scheduling/`.
//
// Each schedule owns two files inside:
//   `<scheduleId>.jsonl`      — append-only outcome log (one line per
//                                ScheduleOutcome).
//   `<scheduleId>.status.json` — current status sentinel ({ status,
//                                updatedAt, reason? }). Absent file means
//                                "probationary by default" (new schedule).
//
// Both files are session-scoped because schedules live inside a session's
// pack context. Cross-session schedule durability is DURABLE.1's concern.
// ---------------------------------------------------------------------------

export function scheduleOutcomeDir(sessionId: string): string {
  return join(OPENSQUID_HOME(), 'sessions', sessionId, 'scheduling');
}

function outcomeLogPath(sessionId: string, scheduleId: string): string {
  return join(scheduleOutcomeDir(sessionId), `${scheduleId}.jsonl`);
}

function statusPath(sessionId: string, scheduleId: string): string {
  return join(scheduleOutcomeDir(sessionId), `${scheduleId}.status.json`);
}

// ---------------------------------------------------------------------------
// captureScheduleOutcome — Stage 1. Append to the outcome log AND surface as
// a `potential-lessons` buffer entry so the user walks it at end-of-run.
//
// The two writes are independent on purpose:
//   - The JSONL log is the SOURCE OF TRUTH for evaluation (Stage 2 reads it).
//   - The buffer entry is the USER-FACING surface (the buffer walk shows it).
//
// If the buffer write fails (e.g. fs full), the JSONL append already
// succeeded — the outcome is still recorded for audit + evaluation.
//
// Throws on missing required fields (no silent acceptance — same contract as
// `capturePendingLesson`).
// ---------------------------------------------------------------------------

export async function captureScheduleOutcome(
  sessionId: string,
  outcome: ScheduleOutcome,
): Promise<void> {
  if (!outcome.scheduleId) throw new Error('captureScheduleOutcome: scheduleId required');
  if (!outcome.runId) throw new Error('captureScheduleOutcome: runId required');
  if (Number.isNaN(Date.parse(outcome.fireTime))) {
    throw new Error(`captureScheduleOutcome: fireTime not parseable: ${outcome.fireTime}`);
  }

  const dir = scheduleOutcomeDir(sessionId);
  await mkdir(dir, { recursive: true });

  // JSONL append — one line, atomic at the OS level for writes < PIPE_BUF
  // (typically 4 KiB), well above a single ScheduleOutcome JSON blob.
  const line = JSON.stringify(outcome) + '\n';
  await appendFile(outcomeLogPath(sessionId, outcome.scheduleId), line, 'utf8');

  // Stage 1 buffer entry — user walks this at end-of-run via the cycle UI.
  // `proposedCategory: 'schedule_outcome'` records the lesson type even
  // though the entry lives under `potential-lessons` (buffer categories are
  // physical directories; lesson type is metadata).
  await appendBufferEntry(sessionId, {
    id: outcome.runId,
    category: 'potential-lessons',
    body: renderOutcomeBody(outcome),
    frontmatter: {
      timestamp: outcome.fireTime,
      proposedCategory: 'schedule_outcome',
      sourceContext: `schedule ${outcome.scheduleId} fired (${outcome.resultKind})`,
      confidence: 0,
    },
  });
}

function renderOutcomeBody(o: ScheduleOutcome): string {
  const sig =
    o.userSignal === undefined
      ? '(none — awaiting user signal)'
      : o.userSignal.kind === 'manual_override'
        ? `manual_override at ${o.userSignal.overriddenAt} — ${o.userSignal.reason}`
        : o.userSignal.kind === 'approve'
          ? `approve at ${o.userSignal.approvedAt}`
          : `redo at ${o.userSignal.redoneAt}`;
  return [
    '## Schedule outcome',
    '',
    `- schedule: \`${o.scheduleId}\``,
    `- runId: \`${o.runId}\``,
    `- fireTime: ${o.fireTime}`,
    `- durationMs: ${o.durationMs}`,
    `- resultKind: ${o.resultKind}`,
    `- userSignal: ${sig}`,
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// evaluateSchedulePromotion — Stage 2. Reads the outcome log + current
// status; returns a recommendation. PURE w.r.t. its inputs (status + log) —
// does not mutate disk. `applyScheduleVerdict` is the writer.
//
// Window semantics: we look at the MOST RECENT `threshold.windowN` outcomes
// that carry an `approve` or `redo` signal. `manual_override` and unsigned
// entries are skipped from the approve/redo counts BUT are counted in the
// runCount (which is the total of approve + redo + manual_override).
// ---------------------------------------------------------------------------

export async function evaluateSchedulePromotion(
  sessionId: string,
  scheduleId: string,
  threshold: SchedulePromotionThreshold = DEFAULT_SCHEDULE_THRESHOLD,
): Promise<ScheduleVerdict> {
  const status = await readStatus(sessionId, scheduleId);
  const outcomes = await readOutcomes(sessionId, scheduleId);

  // Most-recent-first; we want the trailing window.
  const signaled = outcomes.filter((o) => o.userSignal !== undefined);
  const window = signaled.slice(-threshold.windowN);

  let approvedCount = 0;
  let redoCount = 0;
  let manualOverrideCount = 0;
  let runCount = 0;
  for (const o of window) {
    runCount++;
    const k = o.userSignal?.kind;
    if (k === 'approve') approvedCount++;
    else if (k === 'redo') redoCount++;
    else if (k === 'manual_override') manualOverrideCount++;
  }

  return {
    scheduleId,
    status,
    runCount,
    approvedCount,
    redoCount,
    manualOverrideCount,
    recommend: decideRecommend(
      { runCount, approvedCount, redoCount, manualOverrideCount },
      threshold,
    ),
  };
}

// ---------------------------------------------------------------------------
// decideRecommend — pure decision function.
//
// Precedence (locked per spec §"learn"):
//
//   1. `redoCount >= minRedoRetire` → `retire` (this schedule is doing harm).
//      Independent of `approvedCount`: a schedule that pleased the user 100
//      times but recently caused 3 redoes should be retired, regardless.
//      This is the "harm-detection" gate.
//
//   2. `runCount >= windowN AND approvedCount >= minApproved AND
//       redoCount === 0 AND manualOverrideCount === 0` → `promote`.
//      Per spec test fixture: "4 approve + 1 manual_override →
//      keep_probationary" — manual_override is signal-neutral toward retire
//      (user explicitly chose NOT to retire) but BLOCKS promotion (user
//      stepped in; promoting would be premature). This is a stricter
//      reading than the spec's prose ("approvedCount >= 4 and redoCount ==
//      0 → promote"); the test fixture takes precedence per the spec
//      precedence rules.
//
//   3. otherwise → `keep_probationary`.
// ---------------------------------------------------------------------------

function decideRecommend(
  counts: {
    runCount: number;
    approvedCount: number;
    redoCount: number;
    manualOverrideCount: number;
  },
  threshold: SchedulePromotionThreshold,
): 'promote' | 'retire' | 'keep_probationary' {
  if (counts.redoCount >= threshold.minRedoRetire) return 'retire';
  if (
    counts.runCount >= threshold.windowN &&
    counts.approvedCount >= threshold.minApproved &&
    counts.redoCount === 0 &&
    counts.manualOverrideCount === 0
  ) {
    return 'promote';
  }
  return 'keep_probationary';
}

// ---------------------------------------------------------------------------
// applyScheduleVerdict — write the new status to disk, applying eviction-
// immunity. Returns `{ applied, newStatus, reason? }`.
//
// Rules:
//   - `recommend: 'promote'` + status `'probationary'` → write `'permanent'`.
//   - `recommend: 'retire'` + status `'probationary'` → write `'retired'`.
//   - `recommend: 'retire'` + status `'permanent'`    → REFUSE (eviction-
//      immune); audit reason captured. User CLI is the only retire path
//      for permanent schedules (`{ source: 'user' }` opt-in).
//   - any other case → no-op.
// ---------------------------------------------------------------------------

export interface ApplyVerdictOpts {
  /** If true, force-apply even on eviction-immune statuses. ONLY set this
   *  from a user-initiated path (CLI / cycle UI). Library code never sets
   *  it. The flag exists so the helper has a single audit-able entry point;
   *  user actions go through the same function as auto-recommendations but
   *  are distinguishable in the audit log. */
  userOverride?: boolean;
}

export interface ApplyVerdictResult {
  applied: boolean;
  newStatus: 'probationary' | 'permanent' | 'retired';
  reason?: string;
}

export async function applyScheduleVerdict(
  sessionId: string,
  verdict: ScheduleVerdict,
  opts: ApplyVerdictOpts = {},
): Promise<ApplyVerdictResult> {
  const current = verdict.status;
  const recommend = verdict.recommend;

  if (recommend === 'promote' && current === 'probationary') {
    await writeStatus(sessionId, verdict.scheduleId, 'permanent', 'auto-promoted');
    return { applied: true, newStatus: 'permanent' };
  }

  if (recommend === 'retire') {
    if (current === 'permanent' && !opts.userOverride) {
      // Eviction-immune. Refuse, audit reason.
      return {
        applied: false,
        newStatus: current,
        reason: 'permanent schedule is eviction-immune (user-action-only retire)',
      };
    }
    if (current !== 'retired') {
      const reason = opts.userOverride ? 'user-retired' : 'auto-retired';
      await writeStatus(sessionId, verdict.scheduleId, 'retired', reason);
      return { applied: true, newStatus: 'retired' };
    }
  }

  return { applied: false, newStatus: current };
}

// ---------------------------------------------------------------------------
// Disk I/O helpers — kept private. Status file is JSON for human-readability
// and quick CLI inspection; outcomes are JSONL for append efficiency.
// ---------------------------------------------------------------------------

async function readStatus(
  sessionId: string,
  scheduleId: string,
): Promise<'probationary' | 'permanent' | 'retired'> {
  try {
    const raw = await readFile(statusPath(sessionId, scheduleId), 'utf8');
    const parsed = JSON.parse(raw) as { status?: string };
    if (parsed.status === 'permanent' || parsed.status === 'retired') return parsed.status;
    return 'probationary';
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'probationary';
    throw e;
  }
}

async function writeStatus(
  sessionId: string,
  scheduleId: string,
  status: 'probationary' | 'permanent' | 'retired',
  reason: string,
): Promise<void> {
  const dir = scheduleOutcomeDir(sessionId);
  await mkdir(dir, { recursive: true });
  const body = JSON.stringify({ status, updatedAt: new Date().toISOString(), reason }, null, 2);
  await writeFile(statusPath(sessionId, scheduleId), body, 'utf8');
}

async function readOutcomes(sessionId: string, scheduleId: string): Promise<ScheduleOutcome[]> {
  try {
    const raw = await readFile(outcomeLogPath(sessionId, scheduleId), 'utf8');
    return raw
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as ScheduleOutcome);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}
