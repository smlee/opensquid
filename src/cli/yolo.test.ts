/** `opensquid yolo on|off|status [--project]` — writes the global/project config field + reports state. */
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { registerYoloCli, consumeYoloFlags } from './yolo.js';
import { isYoloMode } from '../runtime/guard/yolo.js';

const PRIOR_HOME = process.env.OPENSQUID_HOME;
let home: string;
let project: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'osq-yolocli-home-'));
  project = await mkdtemp(join(tmpdir(), 'osq-yolocli-proj-'));
  await mkdir(join(project, '.opensquid'), { recursive: true });
  process.env.OPENSQUID_HOME = home; // isolate global config per test
  delete process.env.OPENSQUID_YOLO;
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(project, { recursive: true, force: true });
  if (PRIOR_HOME === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = PRIOR_HOME;
});

/** Run `opensquid yolo …` from within the temp project dir (so --project targets it). */
async function run(args: string[]): Promise<string[]> {
  const lines: string[] = [];
  const program = new Command();
  program.exitOverride();
  registerYoloCli(program, { out: (l) => lines.push(l) });
  const prevCwd = process.cwd();
  process.chdir(project);
  try {
    await program.parseAsync(['node', 'opensquid', 'yolo', ...args]);
  } finally {
    process.chdir(prevCwd);
  }
  return lines;
}

describe('opensquid yolo (verb)', () => {
  it('on → global config ON (isYoloMode true); off → OFF', async () => {
    await run(['on']);
    expect(await isYoloMode(project)).toBe(true);
    await run(['off']);
    expect(await isYoloMode(project)).toBe(false);
  });

  it('bare `yolo` turns it ON (matches bare --yolo)', async () => {
    expect(await isYoloMode(project)).toBe(false);
    await run([]); // bare verb → ON (global)
    expect(await isYoloMode(project)).toBe(true);
  });

  it('--project overrides global for this repo only', async () => {
    await run(['on']); // global ON
    await run(['off', '--project']); // this project opts OUT
    expect(await isYoloMode(project)).toBe(false); // project false beats global true
  });

  it('status reports resolved + per-source breakdown', async () => {
    await run(['on']);
    const out = (await run(['status'])).join(' ');
    expect(out).toMatch(/ON \(resolved\)/);
    expect(out).toMatch(/global: ON/);
  });

  it('an unknown state throws', async () => {
    await expect(run(['maybe'])).rejects.toThrow(/on\|off\|status/);
  });
});

describe('consumeYoloFlags (chainable --yolo, any position)', () => {
  const argv = (...a: string[]) => ['node', 'opensquid', ...a];

  it('bare --yolo → ON (default), tokens stripped', () => {
    expect(consumeYoloFlags(argv('--yolo'))).toEqual({
      rest: ['node', 'opensquid'],
      decision: true,
    });
  });

  it('explicit --yolo on / --yolo off (value consumed, like --port 3000)', () => {
    expect(consumeYoloFlags(argv('--yolo', 'on')).decision).toBe(true);
    expect(consumeYoloFlags(argv('--yolo', 'off')).decision).toBe(false);
  });

  it('--no-yolo and --yolo=on|off forms', () => {
    expect(consumeYoloFlags(argv('--no-yolo')).decision).toBe(false);
    expect(consumeYoloFlags(argv('--yolo=off')).decision).toBe(false);
    expect(consumeYoloFlags(argv('--yolo=on')).decision).toBe(true);
  });

  it('CHAINS at the front WITHOUT swallowing the subcommand (the formerly-broken case)', () => {
    // bare --yolo before a subcommand: `on` is the default, `pack list` survives as the command.
    expect(consumeYoloFlags(argv('--yolo', 'pack', 'list'))).toEqual({
      rest: ['node', 'opensquid', 'pack', 'list'],
      decision: true,
    });
    // explicit value + chained command:
    expect(consumeYoloFlags(argv('--yolo', 'on', 'pack', 'list'))).toEqual({
      rest: ['node', 'opensquid', 'pack', 'list'],
      decision: true,
    });
  });

  it('CHAINS at the end (`<cmd> --yolo`)', () => {
    expect(consumeYoloFlags(argv('pack', 'list', '--yolo'))).toEqual({
      rest: ['node', 'opensquid', 'pack', 'list'],
      decision: true,
    });
  });

  it('no flag → decision null, argv untouched', () => {
    expect(consumeYoloFlags(argv('pack', 'list'))).toEqual({
      rest: ['node', 'opensquid', 'pack', 'list'],
      decision: null,
    });
  });
});
