/**
 * Action implementations for CLI.2 — `opensquid schedule …`.
 *
 * Split out of `schedule.ts` (file-size budget). Each exported function is a
 * single verb's body; `schedule.ts` wires commander to these via thin
 * `.action(opts => action(...))` bridges. Functions take all I/O via
 * explicit `paths` + `out` + `err` deps so they're testable independently.
 *
 * Imports from: node-cron, ../schedule_nl, ./schedule_state,
 *   ./schedule_render, ./triggers_state, ./triggers_synth.
 * Imported by: src/setup/cli/schedule.ts.
 */

import cron from 'node-cron';

import { InvalidCronError, InvalidScheduleInputError, nlToCron } from '../schedule_nl.js';

import { renderListTable, renderNextTable } from './schedule_render.js';
import {
  appendHistory,
  computeNextFire,
  readHistory,
  readOutcomesAcrossSessions,
  readPausedSet,
  readStatusAcrossSessions,
  readUserSchedules,
  writePausedSet,
  writeUserSchedules,
  type ScheduleRow,
  type ScheduleStatus,
  type UserSchedule,
} from './schedule_state.js';
import { enumeratePacks } from './triggers_state.js';
import { synthFireEvent } from './triggers_synth.js';

import type { Event } from '../../runtime/types.js';

export type ScheduleDispatch = (event: Event) => Promise<void> | void;

export interface SchedulePaths {
  packsDir: string;
  userSchedulesPath: string;
  pausedPath: string;
  historyPath: string;
  sessionsDir: string;
}

export interface ActionDeps {
  paths: SchedulePaths;
  out: (s: string) => void;
  err: (s: string) => void;
  isTty: () => boolean;
  now: () => Date;
  dispatch?: ScheduleDispatch;
}

/** Merge pack-declared + user-added schedules into one row set, sorted by
 *  next-fire ascending (nulls last). */
export async function buildScheduleRows(deps: {
  paths: SchedulePaths;
  now: Date;
}): Promise<ScheduleRow[]> {
  const { paths, now } = deps;
  const [packs, userSchedules, paused] = await Promise.all([
    enumeratePacks(paths.packsDir),
    readUserSchedules(paths.userSchedulesPath),
    readPausedSet(paths.pausedPath),
  ]);

  const rows: ScheduleRow[] = [];
  for (const pack of packs) {
    for (const skill of pack.skills) {
      let triggerIndex = -1;
      for (const trigger of skill.triggers) {
        triggerIndex += 1;
        if (trigger.kind !== 'schedule') continue;
        const id = `${pack.name}::${skill.name}::${String(triggerIndex)}`;
        const cronExpr = trigger.cron ?? '';
        const status = await readStatusAcrossSessions(paths.sessionsDir, id);
        const nextFire = cronExpr ? computeNextFire(cronExpr, now) : null;
        rows.push({
          id,
          source: 'pack',
          cron: cronExpr,
          pack: pack.name,
          skill: skill.name,
          timezone: 'UTC',
          paused: paused.has(id),
          status,
          nextFireAt: nextFire ? nextFire.toISOString() : null,
        });
      }
    }
  }
  for (const us of userSchedules) {
    const status = await readStatusAcrossSessions(paths.sessionsDir, us.id);
    const nextFire = computeNextFire(us.cron, now, us.timezone ?? 'UTC');
    const row: ScheduleRow = {
      id: us.id,
      source: 'user',
      cron: us.cron,
      pack: us.pack,
      skill: us.skill,
      timezone: us.timezone ?? 'UTC',
      paused: paused.has(us.id),
      status,
      nextFireAt: nextFire ? nextFire.toISOString() : null,
    };
    if (us.costTier !== undefined) row.costTier = us.costTier;
    rows.push(row);
  }
  rows.sort((a, b) => {
    if (a.nextFireAt === null && b.nextFireAt === null) return a.id.localeCompare(b.id);
    if (a.nextFireAt === null) return 1;
    if (b.nextFireAt === null) return -1;
    return a.nextFireAt.localeCompare(b.nextFireAt);
  });
  return rows;
}

function genUserId(pack: string, skill: string, existing: readonly UserSchedule[]): string {
  let n = 0;
  let id = `user:${pack}.${skill}.0`;
  while (existing.some((s) => s.id === id)) {
    n += 1;
    id = `user:${pack}.${skill}.${String(n)}`;
  }
  return id;
}

async function confirm(
  question: string,
  out: (s: string) => void,
  isTty: () => boolean,
): Promise<boolean> {
  if (!isTty()) return false;
  const rl = (await import('node:readline/promises')).createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
    out('');
  }
}

export async function actList(
  deps: ActionDeps,
  opts: { pack?: string; status?: string },
): Promise<void> {
  const rows = (await buildScheduleRows({ paths: deps.paths, now: deps.now() })).filter(
    (r) =>
      (opts.pack === undefined || r.pack === opts.pack) &&
      (opts.status === undefined || r.status === (opts.status as ScheduleStatus)),
  );
  if (rows.length === 0) {
    deps.out('(no schedules found)\n');
    return;
  }
  deps.out(renderListTable(rows, deps.isTty()) + '\n');
}

export async function actNext(deps: ActionDeps, opts: { limit: string }): Promise<void> {
  const limit = Math.max(1, Number.parseInt(opts.limit, 10) || 10);
  const rows = await buildScheduleRows({ paths: deps.paths, now: deps.now() });
  const eligible = rows
    .filter((r) => !r.paused && r.nextFireAt !== null)
    .slice(0, limit)
    .map((r) => ({ id: r.id, cron: r.cron, nextFireAt: r.nextFireAt }));
  if (eligible.length === 0) {
    deps.out('(no upcoming firings within 30d)\n');
    return;
  }
  deps.out(renderNextTable(eligible, deps.now(), deps.isTty()) + '\n');
}

export async function actHistory(
  deps: ActionDeps,
  opts: { limit: string; id?: string },
): Promise<void> {
  const limit = Math.max(1, Number.parseInt(opts.limit, 10) || 50);
  const forceFires = await readHistory(deps.paths.historyPath);
  const rows = await buildScheduleRows({ paths: deps.paths, now: deps.now() });
  const targets = opts.id !== undefined ? [opts.id] : rows.map((r) => r.id);
  const items: { firedAt: string; id: string; source: string; resultKind?: string }[] = [];
  for (const id of targets) {
    const outcomes = await readOutcomesAcrossSessions(deps.paths.sessionsDir, id);
    for (const o of outcomes) {
      items.push({ firedAt: o.fireTime, id, source: 'cron', resultKind: o.resultKind });
    }
  }
  for (const f of forceFires) {
    if (opts.id !== undefined && f.scheduleId !== opts.id) continue;
    const item: { firedAt: string; id: string; source: string; resultKind?: string } = {
      firedAt: f.firedAt,
      id: f.scheduleId,
      source: f.source,
    };
    if (f.resultKind !== undefined) item.resultKind = f.resultKind;
    items.push(item);
  }
  items.sort((a, b) => b.firedAt.localeCompare(a.firedAt));
  const slice = items.slice(0, limit);
  if (slice.length === 0) {
    deps.out('(no fires recorded)\n');
    return;
  }
  for (const i of slice) {
    deps.out(
      `${i.firedAt}  ${i.id}  source=${i.source}${i.resultKind !== undefined ? `  result=${i.resultKind}` : ''}\n`,
    );
  }
}

export interface AddOpts {
  cron?: string;
  pack: string;
  skill: string;
  costTier?: 'cheap' | 'balanced' | 'premium';
  timezone?: string;
}

export async function actAdd(deps: ActionDeps, description: string, opts: AddOpts): Promise<void> {
  const existing = await readUserSchedules(deps.paths.userSchedulesPath);
  const id = genUserId(opts.pack, opts.skill, existing);
  let cronExpr: string;
  let nlInput: string | undefined;
  let timezone: string | undefined = opts.timezone;

  if (opts.cron !== undefined) {
    const expr = opts.cron.trim();
    const fieldCount = expr.split(/\s+/).length;
    if (fieldCount !== 5) {
      deps.err(
        `opensquid schedule add: --cron "${expr}" has ${String(fieldCount)} fields; expected 5-field POSIX cron\n`,
      );
      process.exitCode = 1;
      return;
    }
    if (!cron.validate(expr)) {
      deps.err(`opensquid schedule add: --cron "${expr}" is not a valid 5-field POSIX cron\n`);
      process.exitCode = 1;
      return;
    }
    cronExpr = expr;
  } else {
    try {
      const result = await nlToCron(description);
      cronExpr = result.cron;
      nlInput = result.nl_input;
      if (result.timezone !== undefined && timezone === undefined) timezone = result.timezone;
    } catch (e) {
      if (e instanceof InvalidScheduleInputError || e instanceof InvalidCronError) {
        deps.err(`opensquid schedule add: ${e.message}\n`);
        deps.err(`hint: pass --cron "<expr>" to skip natural-language translation\n`);
        process.exitCode = 1;
        return;
      }
      deps.err(`opensquid schedule add: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
      return;
    }
  }

  const entry: UserSchedule = {
    id,
    cron: cronExpr,
    pack: opts.pack,
    skill: opts.skill,
    addedAt: deps.now().toISOString(),
  };
  if (opts.costTier !== undefined) entry.costTier = opts.costTier;
  if (timezone !== undefined) entry.timezone = timezone;
  if (nlInput !== undefined) entry.nlInput = nlInput;

  await writeUserSchedules(deps.paths.userSchedulesPath, [...existing, entry]);
  deps.out(
    `${JSON.stringify(
      {
        id,
        cron: cronExpr,
        pack: opts.pack,
        skill: opts.skill,
        status: 'probationary',
        ...(timezone !== undefined ? { timezone } : {}),
        ...(opts.costTier !== undefined ? { costTier: opts.costTier } : {}),
        ...(nlInput !== undefined ? { nlInput } : {}),
      },
      null,
      2,
    )}\n`,
  );
}

export async function actRemove(
  deps: ActionDeps,
  id: string,
  opts: { yes: boolean },
): Promise<void> {
  const existing = await readUserSchedules(deps.paths.userSchedulesPath);
  if (!existing.some((u) => u.id === id)) {
    deps.err(
      `opensquid schedule remove: "${id}" is not a user-added schedule (pack-declared schedules are managed via the pack manifest; use \`opensquid triggers disable\` to disable them)\n`,
    );
    process.exitCode = 1;
    return;
  }
  if (!opts.yes && !deps.isTty()) {
    deps.err(
      `opensquid schedule remove: refusing to remove "${id}" without --yes in non-interactive context\n`,
    );
    process.exitCode = 1;
    return;
  }
  if (!opts.yes && !(await confirm(`Remove schedule "${id}"? [y/N] `, deps.out, deps.isTty))) {
    deps.out('aborted\n');
    return;
  }
  await writeUserSchedules(
    deps.paths.userSchedulesPath,
    existing.filter((u) => u.id !== id),
  );
  const paused = await readPausedSet(deps.paths.pausedPath);
  if (paused.delete(id)) await writePausedSet(deps.paths.pausedPath, paused);
  deps.out(`removed ${id}\n`);
}

export async function actPauseResume(
  deps: ActionDeps,
  verb: 'pause' | 'resume',
  id: string,
): Promise<void> {
  const existing = await readUserSchedules(deps.paths.userSchedulesPath);
  if (!existing.some((u) => u.id === id)) {
    deps.err(
      `opensquid schedule ${verb}: "${id}" is not a user-added schedule (pack-declared schedules use \`opensquid triggers ${verb === 'pause' ? 'disable' : 'enable'}\`)\n`,
    );
    process.exitCode = 1;
    return;
  }
  const paused = await readPausedSet(deps.paths.pausedPath);
  if (verb === 'pause') paused.add(id);
  else paused.delete(id);
  await writePausedSet(deps.paths.pausedPath, paused);
  deps.out(`${verb === 'pause' ? 'paused' : 'resumed'} ${id}\n`);
}

export async function actRun(deps: ActionDeps, id: string, opts: { yes: boolean }): Promise<void> {
  const rows = await buildScheduleRows({ paths: deps.paths, now: deps.now() });
  const row = rows.find((r) => r.id === id);
  if (!row) {
    deps.err(`opensquid schedule run: no schedule with id "${id}"\n`);
    process.exitCode = 1;
    return;
  }
  if (!opts.yes && !deps.isTty()) {
    deps.err(
      `opensquid schedule run: refusing to fire "${id}" without --yes in non-interactive context\n`,
    );
    process.exitCode = 1;
    return;
  }
  if (!opts.yes && !(await confirm(`Force-fire schedule "${id}"? [y/N] `, deps.out, deps.isTty))) {
    deps.out('aborted\n');
    return;
  }
  const firedAt = deps.now().toISOString();
  await appendHistory(deps.paths.historyPath, { scheduleId: id, firedAt, source: 'cli.run' });
  if (deps.dispatch) {
    await deps.dispatch(
      synthFireEvent(
        {
          id: row.id,
          pack: row.pack,
          skill: row.skill,
          kind: 'schedule',
          index: 0,
          filter: '',
          enabled: !row.paused,
        },
        { kind: 'schedule', cron: row.cron },
        deps.now(),
      ),
    );
  }
  deps.out(`fired ${id}\n`);
}
