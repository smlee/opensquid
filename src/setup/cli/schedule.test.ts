/**
 * Tests for CLI.2 — `opensquid schedule list|next|history|add|remove|pause|
 * resume|run`.
 *
 * Strategy mirrors triggers.test.ts: fixture packsDir via `mkdtemp` with two
 * packs declaring schedule triggers, drive verbs via `commander.parseAsync`
 * against `registerSchedule` with injected stdout/stderr/dispatch/now deps.
 * NL→cron exercised via the same fake-LLM trick as schedule_nl.test.ts
 * (a tiny node script piped through `OPENSQUID_MODELS_CONFIG_INLINE`).
 */

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModelAliasConfig } from '../../models/types.js';
import type { Event } from '../../runtime/types.js';

import { registerSchedule } from './schedule.js';
import { computeNextFire, readUserSchedules, readPausedSet } from './schedule_state.js';

let packsDir: string;
let stateRoot: string;
let userSchedulesPath: string;
let pausedPath: string;
let historyPath: string;
let sessionsDir: string;
let outChunks: string[];
let errChunks: string[];
let priorInline: string | undefined;
let priorHome: string | undefined;

const out = (s: string): void => {
  outChunks.push(s);
};
const errSink = (s: string): void => {
  errChunks.push(s);
};
const outText = (): string => outChunks.join('');
const errText = (): string => errChunks.join('');

async function writePack(
  root: string,
  name: string,
  skills: { name: string; triggers: unknown[] }[],
): Promise<void> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'manifest.yaml'),
    `name: ${name}\nversion: 0.0.1\nscope: project\ngoal: test fixture\n`,
    'utf8',
  );
  for (const skill of skills) {
    const skillDir = join(dir, 'skills', skill.name);
    await mkdir(skillDir, { recursive: true });
    const triggersBlock = skill.triggers.map((t) => `  - ${JSON.stringify(t)}`).join('\n');
    await writeFile(
      join(skillDir, 'skill.yaml'),
      `name: ${skill.name}\ntriggers:\n${triggersBlock}\n`,
      'utf8',
    );
  }
}

async function writeFakeLlm(output: string): Promise<string> {
  const script = `
let buf = '';
process.stdin.on('data', (d) => { buf += d; });
process.stdin.on('end', () => {
  process.stdout.write(${JSON.stringify(output)});
  process.exit(0);
});
`;
  const path = join(stateRoot, `fake-llm-${Math.random().toString(36).slice(2, 8)}.js`);
  await writeFile(path, script, 'utf8');
  return path;
}

function installAlias(alias: string, scriptPath: string): void {
  const cfg: Record<string, ModelAliasConfig> = {
    [alias]: {
      mode: 'subscription',
      impl: 'cli',
      cli: process.execPath,
      args: [scriptPath],
    },
  };
  process.env.OPENSQUID_MODELS_CONFIG_INLINE = JSON.stringify(cfg);
}

const fixedNow = (): Date => new Date('2026-05-20T08:00:00Z');

beforeEach(async () => {
  priorInline = process.env.OPENSQUID_MODELS_CONFIG_INLINE;
  priorHome = process.env.OPENSQUID_HOME;
  packsDir = await mkdtemp(join(tmpdir(), 'opensquid-schedule-packs-'));
  stateRoot = await mkdtemp(join(tmpdir(), 'opensquid-schedule-state-'));
  process.env.OPENSQUID_HOME = stateRoot;
  userSchedulesPath = join(stateRoot, 'schedules.yaml');
  pausedPath = join(stateRoot, 'schedule_paused.yaml');
  historyPath = join(stateRoot, 'schedule_history.jsonl');
  sessionsDir = join(stateRoot, 'sessions');
  outChunks = [];
  errChunks = [];

  // Two pack-declared schedules:
  //   ci::drift-digest::0  every Monday at 9   (0 9 * * 1)
  //   ci::drift-digest::1  every 5 min         (*/5 * * * *)
  await writePack(packsDir, 'ci', [
    {
      name: 'drift-digest',
      triggers: [
        { kind: 'schedule', cron: '0 9 * * 1' },
        { kind: 'schedule', cron: '*/5 * * * *' },
      ],
    },
  ]);
  // One non-schedule pack to confirm filter narrowing.
  await writePack(packsDir, 'unrelated', [
    { name: 'tool-only', triggers: [{ kind: 'tool_call' }] },
  ]);
});

afterEach(() => {
  if (priorInline === undefined) delete process.env.OPENSQUID_MODELS_CONFIG_INLINE;
  else process.env.OPENSQUID_MODELS_CONFIG_INLINE = priorInline;
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
  vi.restoreAllMocks();
});

function build(deps: Parameters<typeof registerSchedule>[1] = {}): Command {
  const program = new Command();
  registerSchedule(program, {
    packsDir,
    userSchedulesPath,
    pausedPath,
    historyPath,
    sessionsDir,
    stdout: out,
    stderr: errSink,
    isTty: () => false,
    now: fixedNow,
    ...deps,
  });
  return program;
}

const argv = (...args: string[]): string[] => ['node', 'cli', 'schedule', ...args];

describe('opensquid schedule list', () => {
  it('lists pack-declared schedules with source + status columns', async () => {
    await build().parseAsync(argv('list'));
    const text = outText();
    expect(text).toContain('ID');
    expect(text).toContain('SOURCE');
    expect(text).toContain('STATUS');
    expect(text).toContain('ci::drift-digest::0');
    expect(text).toContain('ci::drift-digest::1');
    expect(text).toContain('pack');
    expect(text).toContain('probationary');
    // unrelated pack has no schedule triggers
    expect(text).not.toContain('tool-only');
  });

  it('--pack ci filters to one pack', async () => {
    await build().parseAsync(argv('list', '--pack', 'ci'));
    expect(outText()).toContain('ci::drift-digest::0');
  });

  it('--status filters by SCHED.4 wedge status', async () => {
    // Seed a permanent status for ci::drift-digest::0 in a fake session.
    const sessionDir = join(sessionsDir, 'sess-test', 'scheduling');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, 'ci::drift-digest::0.status.json'),
      JSON.stringify({ status: 'permanent', updatedAt: '2026-05-19T00:00:00Z' }),
      'utf8',
    );
    await build().parseAsync(argv('list', '--status', 'permanent'));
    expect(outText()).toContain('ci::drift-digest::0');
    expect(outText()).not.toContain('ci::drift-digest::1');
  });

  it('reports "(no schedules found)" when filters match nothing', async () => {
    await build().parseAsync(argv('list', '--pack', 'nonexistent'));
    expect(outText()).toContain('(no schedules found)');
  });

  it('lists pack-declared + user-added together with both source labels', async () => {
    // First add a user schedule via --cron.
    await build().parseAsync(
      argv('add', 'manual job', '--cron', '0 0 * * *', '--pack', 'manual', '--skill', 'nightly'),
    );
    outChunks = [];
    await build().parseAsync(argv('list'));
    const text = outText();
    expect(text).toContain('ci::drift-digest::0');
    expect(/\buser\b/.exec(text)).toBeTruthy();
    expect(/\bpack\b/.exec(text)).toBeTruthy();
  });
});

describe('opensquid schedule next', () => {
  it('renders an upcoming-firings table with IN column', async () => {
    await build().parseAsync(argv('next', '--limit', '5'));
    const lines = outText().trim().split('\n');
    expect(lines[0]).toMatch(/ID\s+CRON\s+NEXT FIRE\s+IN/);
    // 2026-05-20 is a Wednesday — `0 9 * * 1` next fire is Mon 2026-05-25 09:00Z
    expect(outText()).toContain('2026-05-25T09:00:00.000Z');
    // `*/5 * * * *` from 2026-05-20T08:00:00Z → next is 08:05:00Z
    expect(outText()).toContain('2026-05-20T08:05:00.000Z');
  });

  it('skips paused schedules', async () => {
    // Add a user schedule + pause it.
    await build().parseAsync(
      argv('add', 'every minute', '--cron', '* * * * *', '--pack', 'manual', '--skill', 'mn'),
    );
    const added = await readUserSchedules(userSchedulesPath);
    const userId = added[0]!.id;
    outChunks = [];
    await build().parseAsync(argv('pause', userId));
    outChunks = [];
    await build().parseAsync(argv('next'));
    // user schedule (paused) does not appear, but pack-declared still does
    expect(outText()).not.toContain(userId);
    expect(outText()).toContain('ci::drift-digest::1');
  });
});

describe('opensquid schedule history', () => {
  it('returns "(no fires recorded)" when no fires + no outcomes', async () => {
    await build().parseAsync(argv('history'));
    expect(outText()).toContain('(no fires recorded)');
  });

  it('merges SCHED.4 outcomes + force-fires sorted desc', async () => {
    // Write a session outcome.
    const sessionDir = join(sessionsDir, 'sess-h', 'scheduling');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, 'ci::drift-digest::0.jsonl'),
      JSON.stringify({
        scheduleId: 'ci::drift-digest::0',
        runId: 'r1',
        fireTime: '2026-05-18T09:00:00Z',
        durationMs: 100,
        resultKind: 'pass',
      }) + '\n',
      'utf8',
    );
    // Run a force-fire (will append a 'cli.run' entry).
    await build().parseAsync(argv('run', 'ci::drift-digest::0', '--yes'));
    outChunks = [];
    await build().parseAsync(argv('history'));
    const text = outText();
    expect(text).toContain('ci::drift-digest::0');
    expect(text).toContain('source=cron');
    expect(text).toContain('source=cli.run');
    // Force-fire (2026-05-20T08:00:00Z) is newer than outcome (2026-05-18)
    const lines = text.trim().split('\n');
    expect(lines[0]).toContain('2026-05-20');
  });
});

describe('opensquid schedule add', () => {
  it('--cron bypasses the LLM and persists exactly the expression', async () => {
    // No alias installed → if anything calls NL→cron, it will throw.
    process.env.OPENSQUID_MODELS_CONFIG_INLINE = JSON.stringify({});
    await build().parseAsync(
      argv(
        'add',
        'unused description',
        '--cron',
        '*/5 * * * *',
        '--pack',
        'ci',
        '--skill',
        'heartbeat',
        '--cost-tier',
        'cheap',
      ),
    );
    const persisted = await readUserSchedules(userSchedulesPath);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.cron).toBe('*/5 * * * *');
    expect(persisted[0]?.costTier).toBe('cheap');
    expect(persisted[0]?.nlInput).toBeUndefined();
    const parsed = JSON.parse(outText()) as Record<string, unknown>;
    expect(parsed.cron).toBe('*/5 * * * *');
    expect(parsed.status).toBe('probationary');
  });

  it('NL description routes through fast_classifier and persists translation', async () => {
    installAlias('fast_classifier', await writeFakeLlm('0 9 * * 1'));
    await build().parseAsync(
      argv('add', 'every Monday at 9am', '--pack', 'ci', '--skill', 'drift-digest'),
    );
    const persisted = await readUserSchedules(userSchedulesPath);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.cron).toBe('0 9 * * 1');
    expect(persisted[0]?.nlInput).toBe('every Monday at 9am');
  });

  it('--cron rejects wrong-field-count expressions without LLM call', async () => {
    process.env.OPENSQUID_MODELS_CONFIG_INLINE = JSON.stringify({});
    const prev = process.exitCode;
    await build().parseAsync(
      argv('add', 'x', '--cron', 'not a cron', '--pack', 'ci', '--skill', 's'),
    );
    expect(process.exitCode).toBe(1);
    expect(errText()).toContain('expected 5-field POSIX cron');
    process.exitCode = prev;
  });

  it('--cron rejects 5-field-shaped-but-invalid expressions', async () => {
    process.env.OPENSQUID_MODELS_CONFIG_INLINE = JSON.stringify({});
    const prev = process.exitCode;
    await build().parseAsync(
      argv('add', 'x', '--cron', '99 99 99 99 99', '--pack', 'ci', '--skill', 's'),
    );
    expect(process.exitCode).toBe(1);
    expect(errText()).toContain('not a valid 5-field POSIX cron');
    process.exitCode = prev;
  });

  it('falls through with hint when NL output is invalid', async () => {
    installAlias('fast_classifier', await writeFakeLlm('blubbering nonsense'));
    const prev = process.exitCode;
    await build().parseAsync(argv('add', 'blubbering nonsense', '--pack', 'ci', '--skill', 's'));
    expect(process.exitCode).toBe(1);
    expect(errText()).toContain('not a valid 5-field POSIX cron');
    expect(errText()).toContain('hint: pass --cron');
    process.exitCode = prev;
  });
});

describe('opensquid schedule remove', () => {
  it('removes a user-added schedule with --yes', async () => {
    await build().parseAsync(
      argv('add', 'x', '--cron', '0 0 * * *', '--pack', 'manual', '--skill', 'n'),
    );
    const id = (await readUserSchedules(userSchedulesPath))[0]!.id;
    outChunks = [];
    await build().parseAsync(argv('remove', id, '--yes'));
    expect(outText()).toContain(`removed ${id}`);
    expect(await readUserSchedules(userSchedulesPath)).toHaveLength(0);
  });

  it('refuses without --yes in non-TTY', async () => {
    await build().parseAsync(
      argv('add', 'x', '--cron', '0 0 * * *', '--pack', 'manual', '--skill', 'n'),
    );
    const id = (await readUserSchedules(userSchedulesPath))[0]!.id;
    outChunks = [];
    errChunks = [];
    const prev = process.exitCode;
    await build().parseAsync(argv('remove', id));
    expect(process.exitCode).toBe(1);
    expect(errText()).toContain('refusing to remove');
    expect(await readUserSchedules(userSchedulesPath)).toHaveLength(1);
    process.exitCode = prev;
  });

  it('refuses to remove pack-declared schedules', async () => {
    const prev = process.exitCode;
    await build().parseAsync(argv('remove', 'ci::drift-digest::0', '--yes'));
    expect(process.exitCode).toBe(1);
    expect(errText()).toContain('is not a user-added schedule');
    expect(errText()).toContain('triggers disable');
    process.exitCode = prev;
  });
});

describe('opensquid schedule pause/resume round-trip', () => {
  it('pause adds to paused set; resume removes', async () => {
    await build().parseAsync(
      argv('add', 'x', '--cron', '0 0 * * *', '--pack', 'manual', '--skill', 'n'),
    );
    const id = (await readUserSchedules(userSchedulesPath))[0]!.id;

    outChunks = [];
    await build().parseAsync(argv('pause', id));
    expect(outText()).toContain(`paused ${id}`);
    expect(await readPausedSet(pausedPath)).toEqual(new Set([id]));

    outChunks = [];
    await build().parseAsync(argv('list'));
    expect(outText()).toContain('paused');

    outChunks = [];
    await build().parseAsync(argv('resume', id));
    expect(outText()).toContain(`resumed ${id}`);
    expect(await readPausedSet(pausedPath)).toEqual(new Set());
  });

  it('refuses pause on pack-declared schedules with triggers-disable hint', async () => {
    const prev = process.exitCode;
    await build().parseAsync(argv('pause', 'ci::drift-digest::0'));
    expect(process.exitCode).toBe(1);
    expect(errText()).toContain('triggers disable');
    process.exitCode = prev;
  });
});

describe('opensquid schedule run', () => {
  it('force-fires a schedule, writes history, dispatches when wired', async () => {
    const dispatch = vi.fn<(e: Event) => Promise<void>>(() => Promise.resolve());
    await build({ dispatch }).parseAsync(argv('run', 'ci::drift-digest::0', '--yes'));
    expect(outText()).toContain('fired ci::drift-digest::0');
    expect(dispatch).toHaveBeenCalledOnce();
    const event = dispatch.mock.calls[0]?.[0];
    expect(event?.kind).toBe('schedule');
    if (event?.kind === 'schedule') {
      expect(event.scheduleId).toBe('ci::drift-digest::0');
    }
    const historyRaw = await readFile(historyPath, 'utf8');
    expect(historyRaw).toContain('ci::drift-digest::0');
    expect(historyRaw).toContain('cli.run');
  });

  it('refuses without --yes in non-TTY context', async () => {
    const dispatch = vi.fn();
    const prev = process.exitCode;
    await build({ dispatch }).parseAsync(argv('run', 'ci::drift-digest::0'));
    expect(process.exitCode).toBe(1);
    expect(dispatch).not.toHaveBeenCalled();
    expect(errText()).toContain('refusing to fire');
    process.exitCode = prev;
  });

  it('exits 1 on nonexistent id', async () => {
    const prev = process.exitCode;
    await build().parseAsync(argv('run', 'nope::nope::0', '--yes'));
    expect(process.exitCode).toBe(1);
    expect(errText()).toContain('no schedule with id');
    process.exitCode = prev;
  });
});

describe('computeNextFire (pure helper)', () => {
  it('handles "*/5 * * * *" and ticks to next 5-min boundary', () => {
    const from = new Date('2026-05-20T08:02:13Z');
    const next = computeNextFire('*/5 * * * *', from, 'UTC');
    expect(next?.toISOString()).toBe('2026-05-20T08:05:00.000Z');
  });

  it('handles weekday DOW filter "0 18 * * 1-5"', () => {
    // Sunday 2026-05-17T00:00Z → next fire Monday 18:00Z
    const from = new Date('2026-05-17T00:00:00Z');
    const next = computeNextFire('0 18 * * 1-5', from, 'UTC');
    expect(next?.toISOString()).toBe('2026-05-18T18:00:00.000Z');
  });

  it('returns null for impossible expressions within horizon', () => {
    // Feb 31 — never fires. node-cron may accept but computeNextFire
    // will scan 30d without a match.
    const from = new Date('2026-01-01T00:00:00Z');
    expect(computeNextFire('0 0 31 2 *', from, 'UTC')).toBeNull();
  });
});
