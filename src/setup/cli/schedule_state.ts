/**
 * Schedule state + persistence helpers for CLI.2.
 *
 * Split out of `schedule.ts` (file-size budget). Five concerns:
 *
 *   1. `readUserSchedules` / `writeUserSchedules` — load + atomically rewrite
 *      `~/.opensquid/schedules.yaml`. Holds USER-ADDED schedules only.
 *      Pack-declared schedules live in pack manifests and are read via
 *      `enumeratePacks` (from CLI.1). The CLI's view is the merged union.
 *   2. `readPausedSet` / `writePausedSet` — `~/.opensquid/schedule_paused.yaml`.
 *      Pause/resume applies to user-added schedules ONLY (pack-declared
 *      schedules are managed via the pack manifest, never the CLI).
 *   3. `appendHistory` / `readHistory` — `~/.opensquid/schedule_history.jsonl`
 *      for force-fire records. Combined with per-session SCHED.4 outcome logs
 *      to produce the `history` view.
 *   4. `readStatusAcrossSessions` — walks `~/.opensquid/sessions/<id>/
 *      scheduling/<scheduleId>.status.json` and returns the most-recent
 *      status sentinel. Defaults to 'probationary' when nothing on disk.
 *   5. `computeNextFire` — minute-by-minute walker over a small pure
 *      5-field POSIX cron matcher. Bounded horizon (30 d) so we never spin
 *      on a pathological expression. node-cron has no public `getNext` —
 *      we ship our own matcher rather than reach into node-cron internals.
 *
 * Schedule id format (user-added): `user:<name>` — `name` is the
 * `<pack>.<skill>.<n>` suffix the CLI generates so two `add` calls with the
 * same (pack, skill) produce distinct ids. Pack-declared schedule ids come
 * from `ScheduleRegistry` (`<pack>::<skill>::<index>`) — we surface them
 * unchanged so audit logs match.
 *
 * Imports from: node:fs/promises, yaml, ../../runtime/paths,
 *   ../../runtime/wedge/schedule_outcome.
 * Imported by: src/setup/cli/schedule.ts + src/setup/cli/schedule_actions.ts.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { OPENSQUID_HOME } from '../../runtime/paths.js';
import { scheduleOutcomeDir, type ScheduleOutcome } from '../../runtime/wedge/schedule_outcome.js';

import {
  appendJsonlEntry,
  readJsonlEntries,
  readKeyedYamlList,
  writeKeyedYamlList,
} from './state_io.js';

/** One user-added schedule. Matches pack-declared `schedule` triggers in
 *  shape so the CLI can render them through one row type. */
export interface UserSchedule {
  id: string;
  cron: string;
  pack: string;
  skill: string;
  costTier?: 'cheap' | 'balanced' | 'premium';
  timezone?: string;
  /** ISO 8601 — when the user ran `schedule add`. */
  addedAt: string;
  /** Optional original NL input (audit only — not used by dispatch). */
  nlInput?: string;
}

export type ScheduleStatus = 'probationary' | 'permanent' | 'retired';
export type ScheduleSource = 'pack' | 'user';

export interface ScheduleRow {
  id: string;
  source: ScheduleSource;
  cron: string;
  pack: string;
  skill: string;
  timezone: string;
  costTier?: 'cheap' | 'balanced' | 'premium';
  paused: boolean;
  status: ScheduleStatus;
  nextFireAt: string | null;
}

export interface HistoryEntry {
  scheduleId: string;
  firedAt: string;
  source: 'cron' | 'cli.run' | 'cli.fire';
  resultKind?: 'pass' | 'block' | 'warn' | 'surface' | 'error';
  durationMs?: number;
}

export const defaultUserSchedulesPath = (): string => join(OPENSQUID_HOME(), 'schedules.yaml');
export const defaultPausedPath = (): string => join(OPENSQUID_HOME(), 'schedule_paused.yaml');
export const defaultHistoryPath = (): string => join(OPENSQUID_HOME(), 'schedule_history.jsonl');
export const defaultSessionsDir = (): string => join(OPENSQUID_HOME(), 'sessions');

// ---------------------------------------------------------------------------
// User-added schedules — yaml mapping `{ schedules: [UserSchedule, ...] }`.
// Atomic write via `tmp + rename` matches the trigger_state.yaml pattern.
// ---------------------------------------------------------------------------

const isUserSchedule = (v: unknown): v is UserSchedule => typeof v === 'object' && v !== null;
const isString = (v: unknown): v is string => typeof v === 'string';

export async function readUserSchedules(path: string): Promise<UserSchedule[]> {
  return readKeyedYamlList<UserSchedule>(path, 'schedules', 'schedules.yaml', isUserSchedule);
}

export async function writeUserSchedules(path: string, schedules: UserSchedule[]): Promise<void> {
  return writeKeyedYamlList(path, 'schedules', schedules);
}

// ---------------------------------------------------------------------------
// Paused set — yaml mapping `{ paused: [ <scheduleId>, ... ] }`.
// ---------------------------------------------------------------------------

export async function readPausedSet(path: string): Promise<Set<string>> {
  return new Set(await readKeyedYamlList<string>(path, 'paused', 'schedule_paused.yaml', isString));
}

export async function writePausedSet(path: string, paused: Set<string>): Promise<void> {
  return writeKeyedYamlList(path, 'paused', [...paused].sort());
}

// ---------------------------------------------------------------------------
// History (force-fire records).
//
// Pack-declared schedule fires are captured by SCHED.4's per-session JSONL.
// `schedule run` (CLI) records into this file because the CLI may run with
// no daemon + no active session — we need a daemon-agnostic surface for
// `schedule history` to reflect manual fires.
// ---------------------------------------------------------------------------

export async function appendHistory(path: string, entry: HistoryEntry): Promise<void> {
  return appendJsonlEntry(path, entry);
}

/**
 * Read schedule history JSONL entries. T-SIC L11 NOTE: the previous
 * impl used `.map(JSON.parse)` which throws on a malformed line; the
 * shared helper instead skips silently — matches the lenient posture
 * used by `permissions_state.readAuditEntries` and prevents one bad
 * row from breaking `schedule history`.
 */
export async function readHistory(path: string): Promise<HistoryEntry[]> {
  return readJsonlEntries<HistoryEntry>(path);
}

// ---------------------------------------------------------------------------
// Status — walk `~/.opensquid/sessions/<id>/scheduling/<scheduleId>.status.json`
// and pick the most-recent sentinel. The CLI has no active session, so a
// schedule's "current status" is the union over all sessions that have
// touched it (SCHED.4 captures per session). Missing → 'probationary'.
// ---------------------------------------------------------------------------

export async function readStatusAcrossSessions(
  sessionsDir: string,
  scheduleId: string,
): Promise<ScheduleStatus> {
  let sessions: string[];
  try {
    sessions = await readdir(sessionsDir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'probationary';
    throw e;
  }
  let latestStatus: ScheduleStatus = 'probationary';
  let latestUpdatedAt = 0;
  for (const session of sessions) {
    const dir = scheduleOutcomeDir(session);
    const statusFile = join(dir, `${scheduleId}.status.json`);
    let raw: string;
    try {
      raw = await readFile(statusFile, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw e;
    }
    try {
      const parsed = JSON.parse(raw) as { status?: string; updatedAt?: string };
      const updated = parsed.updatedAt ? Date.parse(parsed.updatedAt) : 0;
      if (Number.isFinite(updated) && updated >= latestUpdatedAt) {
        if (parsed.status === 'permanent' || parsed.status === 'retired') {
          latestStatus = parsed.status;
          latestUpdatedAt = updated;
        } else if (parsed.status === 'probationary' && updated > latestUpdatedAt) {
          latestStatus = 'probationary';
          latestUpdatedAt = updated;
        }
      }
    } catch {
      // skip malformed file — don't fail the whole CLI on one bad sentinel
    }
  }
  return latestStatus;
}

/** Walk all sessions and return SCHED.4 outcome JSONL entries for one
 *  schedule. Used by `schedule history`. */
export async function readOutcomesAcrossSessions(
  sessionsDir: string,
  scheduleId: string,
): Promise<ScheduleOutcome[]> {
  let sessions: string[];
  try {
    sessions = await readdir(sessionsDir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const out: ScheduleOutcome[] = [];
  for (const session of sessions) {
    const file = join(scheduleOutcomeDir(session), `${scheduleId}.jsonl`);
    let s;
    try {
      s = await stat(file);
    } catch {
      continue;
    }
    if (!s.isFile()) continue;
    const raw = await readFile(file, 'utf8');
    for (const line of raw.split('\n')) {
      if (line.length === 0) continue;
      try {
        out.push(JSON.parse(line) as ScheduleOutcome);
      } catch {
        /* skip malformed line */
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// computeNextFire — minute-by-minute walker over a pure 5-field POSIX cron
// matcher.
//
// node-cron does not expose a public `getNext` API and its internal
// `TimeMatcher` is not part of its public surface. Rather than reach into
// node-cron internals OR pull in cron-parser, we ship a small pure matcher
// here. The expression has already been validated upstream by
// `cron.validate()` (in schedule_registry / schedule_nl) — we trust the
// shape and parse field-by-field.
//
// Bounded to 30 d so a degenerate expression that never matches returns
// `null` instead of looping forever.
//
// Timezone semantics: when `timezone` is provided, we convert the date to
// that zone's wall-clock fields via `Intl.DateTimeFormat` before matching.
// Default UTC matches SCHED.1's ScheduleRegistry default.
// ---------------------------------------------------------------------------

const MAX_HORIZON_MS = 30 * 24 * 60 * 60 * 1000;

interface CronFields {
  /** Parsed sets of allowed values per field, in cron order. */
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
}

function expandField(spec: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of spec.split(',')) {
    const slash = part.split('/');
    const range = slash[0] ?? '*';
    const step = slash[1] !== undefined ? Number.parseInt(slash[1], 10) : 1;
    let lo = min;
    let hi = max;
    if (range !== '*') {
      const hyphen = range.split('-');
      lo = Number.parseInt(hyphen[0] ?? '0', 10);
      hi = hyphen[1] !== undefined ? Number.parseInt(hyphen[1], 10) : lo;
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || !Number.isFinite(step) || step <= 0) {
      continue;
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

function parseCronFields(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`computeNextFire: expected 5-field cron, got "${expr}"`);
  const [m, h, dom, mon, dow] = parts as [string, string, string, string, string];
  const dowSet = expandField(dow, 0, 7);
  // Cron tradition: 7 == Sunday == 0. Normalize.
  if (dowSet.has(7)) {
    dowSet.delete(7);
    dowSet.add(0);
  }
  return {
    minute: expandField(m, 0, 59),
    hour: expandField(h, 0, 23),
    dayOfMonth: expandField(dom, 1, 31),
    month: expandField(mon, 1, 12),
    dayOfWeek: dowSet,
  };
}

interface WallClock {
  minute: number;
  hour: number;
  dayOfMonth: number;
  month: number; // 1-12
  dayOfWeek: number; // 0-6 (Sunday=0)
}

function wallClockFor(date: Date, timezone: string): WallClock {
  if (timezone === 'UTC') {
    return {
      minute: date.getUTCMinutes(),
      hour: date.getUTCHours(),
      dayOfMonth: date.getUTCDate(),
      month: date.getUTCMonth() + 1,
      dayOfWeek: date.getUTCDay(),
    };
  }
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  });
  const parts = dtf.formatToParts(date);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return {
    minute: Number.parseInt(get('minute'), 10),
    hour: Number.parseInt(get('hour'), 10) % 24,
    dayOfMonth: Number.parseInt(get('day'), 10),
    month: Number.parseInt(get('month'), 10),
    dayOfWeek: weekdayMap[get('weekday')] ?? 0,
  };
}

export function computeNextFire(cronExpr: string, fromDate: Date, timezone = 'UTC'): Date | null {
  const fields = parseCronFields(cronExpr);

  // Step to the next minute boundary (seconds = 0).
  const start = new Date(fromDate.getTime());
  start.setSeconds(0, 0);
  start.setTime(start.getTime() + 60_000);

  const deadline = fromDate.getTime() + MAX_HORIZON_MS;
  for (let t = start.getTime(); t <= deadline; t += 60_000) {
    const d = new Date(t);
    const wc = wallClockFor(d, timezone);
    if (
      fields.minute.has(wc.minute) &&
      fields.hour.has(wc.hour) &&
      fields.dayOfMonth.has(wc.dayOfMonth) &&
      fields.month.has(wc.month) &&
      fields.dayOfWeek.has(wc.dayOfWeek)
    ) {
      return d;
    }
  }
  return null;
}
