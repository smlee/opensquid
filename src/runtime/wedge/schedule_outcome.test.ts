/**
 * Tests for the schedule-outcome two-stage wedge gate (SCHED.4).
 *
 * Acceptance per docs/tasks/scheduling.md §"Task SCHED.4":
 *  - New schedules start `probationary`.
 *  - Stage 1 lesson capture writes to wedge buffer (no auto-promote).
 *  - Stage 2 evaluator over N runs (default 5, configurable per pack).
 *  - Permanent schedules eviction-immune (user action only).
 *  - manual_override is signal-neutral (does not auto-retire).
 *  - ≥ 8 tests.
 *  - Audit log captures every (run, signal) pair.
 *
 * Strategy: per-test `OPENSQUID_HOME` temp dir; drive
 * captureScheduleOutcome + evaluateSchedulePromotion + applyScheduleVerdict
 * end-to-end; assert filesystem layout, recommendation, and immunity.
 */

import { readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { bufferDir } from './automation_buffer.js';
import {
  applyScheduleVerdict,
  captureScheduleOutcome,
  evaluateSchedulePromotion,
  scheduleOutcomeDir,
  type ScheduleOutcome,
  type SchedulePromotionThreshold,
} from './schedule_outcome.js';

let tempHome: string;
let priorHome: string | undefined;

beforeEach(() => {
  priorHome = process.env.OPENSQUID_HOME;
  tempHome = join(tmpdir(), `opensquid-sched-out-${Math.random().toString(36).slice(2, 10)}`);
  process.env.OPENSQUID_HOME = tempHome;
  runCounter = 0;
});

afterEach(async () => {
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
  await rm(tempHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

type Signal = NonNullable<ScheduleOutcome['userSignal']>;

let runCounter = 0;
function makeOutcome(
  scheduleId: string,
  signal: Signal | 'none',
  overrides: Partial<ScheduleOutcome> = {},
): ScheduleOutcome {
  runCounter++;
  // Spread across minutes to keep ISO valid past 59 runs.
  const minute = Math.floor(runCounter / 60);
  const second = runCounter % 60;
  const fireTime = `2026-05-19T10:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}.000Z`;
  const base: ScheduleOutcome = {
    scheduleId,
    runId: `run-${runCounter}`,
    fireTime,
    durationMs: 42,
    resultKind: 'pass',
  };
  if (signal !== 'none') base.userSignal = signal;
  return { ...base, ...overrides };
}

async function captureN(
  sessionId: string,
  scheduleId: string,
  signals: (Signal | 'none')[],
): Promise<void> {
  for (const s of signals) {
    await captureScheduleOutcome(sessionId, makeOutcome(scheduleId, s));
  }
}

const APPROVE = (n: number): Signal => ({
  kind: 'approve',
  approvedAt: `2026-05-19T11:00:0${n}.000Z`,
});
const REDO = (n: number): Signal => ({
  kind: 'redo',
  redoneAt: `2026-05-19T11:00:0${n}.000Z`,
});
const MANUAL = (n: number, reason = 'test override'): Signal => ({
  kind: 'manual_override',
  overriddenAt: `2026-05-19T11:00:0${n}.000Z`,
  reason,
});

// ---------------------------------------------------------------------------
// Stage 1 — capture
// ---------------------------------------------------------------------------

describe('captureScheduleOutcome (Stage 1)', () => {
  it('writes JSONL outcome log + buffer entry; no auto-promote', async () => {
    const sessionId = 'sess-capture';
    const scheduleId = 'sched-a';

    await captureScheduleOutcome(
      sessionId,
      makeOutcome(scheduleId, APPROVE(1), { runId: 'run-x' }),
    );

    // JSONL log present.
    const log = await readFile(join(scheduleOutcomeDir(sessionId), `${scheduleId}.jsonl`), 'utf8');
    expect(log).toContain('"runId":"run-x"');
    expect(log).toContain('"kind":"approve"');
    expect(log.endsWith('\n')).toBe(true);

    // Buffer entry present under potential-lessons (Stage 1 surface).
    const bufFiles = await readdir(join(bufferDir(sessionId), 'potential-lessons'));
    expect(bufFiles).toHaveLength(1);
    const bufRaw = await readFile(
      join(bufferDir(sessionId), 'potential-lessons', bufFiles[0]!),
      'utf8',
    );
    expect(bufRaw).toContain('proposedCategory: schedule_outcome');
    expect(bufRaw).toContain('Schedule outcome');

    // Status file NOT written (no auto-promote on capture).
    await expect(
      readFile(join(scheduleOutcomeDir(sessionId), `${scheduleId}.status.json`), 'utf8'),
    ).rejects.toThrow();
  });

  it('rejects malformed outcomes (no silent acceptance)', async () => {
    const sessionId = 'sess-bad';
    await expect(captureScheduleOutcome(sessionId, makeOutcome('', APPROVE(1)))).rejects.toThrow(
      /scheduleId/,
    );
    await expect(
      captureScheduleOutcome(sessionId, makeOutcome('s', APPROVE(1), { runId: '' })),
    ).rejects.toThrow(/runId/);
    await expect(
      captureScheduleOutcome(sessionId, makeOutcome('s', APPROVE(1), { fireTime: 'not-a-date' })),
    ).rejects.toThrow(/fireTime/);
  });

  it('audit log captures every (run, signal) pair — including unsigned + manual_override', async () => {
    const sessionId = 'sess-audit';
    const scheduleId = 'sched-audit';

    await captureN(sessionId, scheduleId, [
      APPROVE(1),
      REDO(2),
      MANUAL(3),
      'none', // unsigned fire still recorded
      APPROVE(4),
    ]);

    const log = await readFile(join(scheduleOutcomeDir(sessionId), `${scheduleId}.jsonl`), 'utf8');
    const lines = log.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(5);
    // Five distinct kinds visible in the log (audit completeness).
    const kinds = lines.map((l) => {
      const o = JSON.parse(l) as ScheduleOutcome;
      return o.userSignal?.kind ?? 'none';
    });
    expect(kinds).toEqual(['approve', 'redo', 'manual_override', 'none', 'approve']);
  });
});

// ---------------------------------------------------------------------------
// Stage 2 — evaluator
// ---------------------------------------------------------------------------

describe('evaluateSchedulePromotion (Stage 2)', () => {
  it('new schedule (run count 0) → probationary + keep_probationary', async () => {
    const v = await evaluateSchedulePromotion('sess-new', 'sched-new');
    expect(v.status).toBe('probationary');
    expect(v.runCount).toBe(0);
    expect(v.approvedCount).toBe(0);
    expect(v.redoCount).toBe(0);
    expect(v.recommend).toBe('keep_probationary');
  });

  it('5 runs, all approve, 0 redo → promote', async () => {
    const sessionId = 'sess-promote';
    const scheduleId = 'sched-p';
    await captureN(sessionId, scheduleId, [
      APPROVE(1),
      APPROVE(2),
      APPROVE(3),
      APPROVE(4),
      APPROVE(5),
    ]);
    const v = await evaluateSchedulePromotion(sessionId, scheduleId);
    expect(v.runCount).toBe(5);
    expect(v.approvedCount).toBe(5);
    expect(v.redoCount).toBe(0);
    expect(v.recommend).toBe('promote');
  });

  it('5 runs, 3 redo → retire (harm detection trumps approve count)', async () => {
    const sessionId = 'sess-retire';
    const scheduleId = 'sched-r';
    // 2 approve + 3 redo — by harm-detection precedence, retire wins.
    await captureN(sessionId, scheduleId, [APPROVE(1), APPROVE(2), REDO(3), REDO(4), REDO(5)]);
    const v = await evaluateSchedulePromotion(sessionId, scheduleId);
    expect(v.redoCount).toBe(3);
    expect(v.recommend).toBe('retire');
  });

  it('mixed 4 approve + 1 manual_override → keep_probationary (override blocks promote, not retire)', async () => {
    const sessionId = 'sess-mix';
    const scheduleId = 'sched-mix';
    await captureN(sessionId, scheduleId, [
      APPROVE(1),
      APPROVE(2),
      APPROVE(3),
      APPROVE(4),
      MANUAL(5, 'one-off'),
    ]);
    const v = await evaluateSchedulePromotion(sessionId, scheduleId);
    // Per SCHED.4 spec fixture: manual_override is signal-neutral toward
    // retire (user explicitly chose NOT to retire) BUT blocks promotion
    // (the user stepped in — promoting would be premature).
    expect(v.approvedCount).toBe(4);
    expect(v.redoCount).toBe(0);
    expect(v.manualOverrideCount).toBe(1);
    expect(v.recommend).toBe('keep_probationary');
  });

  it('respects per-pack threshold override (N override)', async () => {
    const sessionId = 'sess-override';
    const scheduleId = 'sched-o';
    const customThreshold: SchedulePromotionThreshold = {
      windowN: 3,
      minApproved: 3,
      minRedoRetire: 2,
    };
    await captureN(sessionId, scheduleId, [APPROVE(1), APPROVE(2), APPROVE(3)]);
    // With default threshold (N=5), would be keep_probationary.
    const vDefault = await evaluateSchedulePromotion(sessionId, scheduleId);
    expect(vDefault.recommend).toBe('keep_probationary');
    expect(vDefault.runCount).toBe(3);
    // With per-pack override N=3, all 3 approve → promote.
    const vCustom = await evaluateSchedulePromotion(sessionId, scheduleId, customThreshold);
    expect(vCustom.recommend).toBe('promote');
  });

  it('only the most recent windowN signaled runs count (sliding window)', async () => {
    const sessionId = 'sess-window';
    const scheduleId = 'sched-w';
    // First 5 are all redo (would retire) — but the most recent 5 are all approve.
    await captureN(sessionId, scheduleId, [
      REDO(1),
      REDO(2),
      REDO(3),
      REDO(4),
      REDO(5),
      APPROVE(1),
      APPROVE(2),
      APPROVE(3),
      APPROVE(4),
      APPROVE(5),
    ]);
    const v = await evaluateSchedulePromotion(sessionId, scheduleId);
    // Sliding window: trailing 5 only.
    expect(v.approvedCount).toBe(5);
    expect(v.redoCount).toBe(0);
    expect(v.recommend).toBe('promote');
  });
});

// ---------------------------------------------------------------------------
// Eviction-immunity (the critical moat invariant)
// ---------------------------------------------------------------------------

describe('applyScheduleVerdict — eviction-immunity for permanent schedules', () => {
  it('promotes probationary → permanent on `promote`', async () => {
    const sessionId = 'sess-apply-promote';
    const scheduleId = 'sched-ap';
    await captureN(sessionId, scheduleId, [
      APPROVE(1),
      APPROVE(2),
      APPROVE(3),
      APPROVE(4),
      APPROVE(5),
    ]);
    const v = await evaluateSchedulePromotion(sessionId, scheduleId);
    expect(v.recommend).toBe('promote');
    const r = await applyScheduleVerdict(sessionId, v);
    expect(r.applied).toBe(true);
    expect(r.newStatus).toBe('permanent');

    // Re-evaluating now reads back permanent status.
    const v2 = await evaluateSchedulePromotion(sessionId, scheduleId);
    expect(v2.status).toBe('permanent');
  });

  it('permanent schedule with 1 fresh redo is NOT auto-demoted', async () => {
    const sessionId = 'sess-immune';
    const scheduleId = 'sched-im';
    // Promote first.
    await captureN(sessionId, scheduleId, [
      APPROVE(1),
      APPROVE(2),
      APPROVE(3),
      APPROVE(4),
      APPROVE(5),
    ]);
    const v1 = await evaluateSchedulePromotion(sessionId, scheduleId);
    await applyScheduleVerdict(sessionId, v1);

    // Single fresh redo — does NOT meet the retire threshold; status stays permanent.
    await captureScheduleOutcome(sessionId, makeOutcome(scheduleId, REDO(6)));
    const v2 = await evaluateSchedulePromotion(sessionId, scheduleId);
    expect(v2.status).toBe('permanent');
    expect(v2.recommend).not.toBe('retire'); // 1 redo < minRedoRetire (3)
    const r2 = await applyScheduleVerdict(sessionId, v2);
    expect(r2.applied).toBe(false);
    expect(r2.newStatus).toBe('permanent');
  });

  it('permanent schedule with 3 redoes REFUSES auto-retire (eviction-immune)', async () => {
    const sessionId = 'sess-immune-hard';
    const scheduleId = 'sched-imh';
    // Promote.
    await captureN(sessionId, scheduleId, [
      APPROVE(1),
      APPROVE(2),
      APPROVE(3),
      APPROVE(4),
      APPROVE(5),
    ]);
    await applyScheduleVerdict(sessionId, await evaluateSchedulePromotion(sessionId, scheduleId));

    // Now 3 redoes arrive — evaluator says retire, but applier refuses.
    await captureN(sessionId, scheduleId, [REDO(1), REDO(2), REDO(3)]);
    const v = await evaluateSchedulePromotion(sessionId, scheduleId);
    expect(v.recommend).toBe('retire');
    const r = await applyScheduleVerdict(sessionId, v);
    expect(r.applied).toBe(false);
    expect(r.newStatus).toBe('permanent');
    expect(r.reason).toMatch(/eviction-immune/);

    // Disk still reports permanent.
    const status = JSON.parse(
      await readFile(join(scheduleOutcomeDir(sessionId), `${scheduleId}.status.json`), 'utf8'),
    ) as { status: string };
    expect(status.status).toBe('permanent');
  });

  it('user-override flag retires a permanent schedule (CLI path)', async () => {
    const sessionId = 'sess-user-retire';
    const scheduleId = 'sched-ur';
    await captureN(sessionId, scheduleId, [
      APPROVE(1),
      APPROVE(2),
      APPROVE(3),
      APPROVE(4),
      APPROVE(5),
    ]);
    await applyScheduleVerdict(sessionId, await evaluateSchedulePromotion(sessionId, scheduleId));

    await captureN(sessionId, scheduleId, [REDO(1), REDO(2), REDO(3)]);
    const v = await evaluateSchedulePromotion(sessionId, scheduleId);
    expect(v.recommend).toBe('retire');
    // User-initiated retire bypasses eviction-immunity.
    const r = await applyScheduleVerdict(sessionId, v, { userOverride: true });
    expect(r.applied).toBe(true);
    expect(r.newStatus).toBe('retired');
  });

  it('probationary schedule with 3 redoes IS auto-retired (immunity only applies to permanent)', async () => {
    const sessionId = 'sess-prob-retire';
    const scheduleId = 'sched-pr';
    await captureN(sessionId, scheduleId, [REDO(1), REDO(2), REDO(3)]);
    const v = await evaluateSchedulePromotion(sessionId, scheduleId);
    expect(v.status).toBe('probationary');
    expect(v.recommend).toBe('retire');
    const r = await applyScheduleVerdict(sessionId, v);
    expect(r.applied).toBe(true);
    expect(r.newStatus).toBe('retired');
  });
});

// ---------------------------------------------------------------------------
// Anti-self-grading invariant: schedule does NOT promote itself based on
// its own verdict counts. The only inputs are user signals.
// ---------------------------------------------------------------------------

describe('anti-self-grading: resultKind alone never promotes', () => {
  it('5 runs all with resultKind="pass" but NO user signal → keep_probationary', async () => {
    const sessionId = 'sess-no-self';
    const scheduleId = 'sched-ns';
    // Five fires, all resultKind=pass, NO user signal — the schedule self-
    // grades itself as "fine" but the gate requires external signal.
    for (let i = 0; i < 5; i++) {
      await captureScheduleOutcome(
        sessionId,
        makeOutcome(scheduleId, 'none', { resultKind: 'pass' }),
      );
    }
    const v = await evaluateSchedulePromotion(sessionId, scheduleId);
    expect(v.approvedCount).toBe(0);
    expect(v.redoCount).toBe(0);
    expect(v.runCount).toBe(0); // unsigned fires don't count toward the window
    expect(v.recommend).toBe('keep_probationary');

    // Even applyScheduleVerdict refuses to promote.
    const r = await applyScheduleVerdict(sessionId, v);
    expect(r.applied).toBe(false);
    expect(r.newStatus).toBe('probationary');
  });

  it('schedule_outcome.ts contains no LLM primitive call (audit-grep invariant)', async () => {
    const src = await readFile(
      join(process.cwd(), 'src/runtime/wedge/schedule_outcome.ts'),
      'utf8',
    );
    // The same audit pattern Phase 7 promote.ts enforces — no LLM primitive
    // names in the promotion path. (Comments documenting the invariant are
    // fine; an actual call is not.)
    expect(src).not.toMatch(/\bllm_classify\s*\(/);
    expect(src).not.toMatch(/\bsubagent_call\s*\(/);
    expect(src).not.toMatch(/\bclassifyAlias\s*\(/);
  });
});
