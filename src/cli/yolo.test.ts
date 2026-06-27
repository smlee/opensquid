/** `opensquid yolo on|off|status` — toggles the marker + reports state. */
import { rm } from 'node:fs/promises';

import { Command } from 'commander';
import { afterEach, describe, expect, it } from 'vitest';

import { registerYoloCli, consumeYoloFlags } from './yolo.js';
import { isYoloMode, yoloMarkerPath } from '../runtime/guard/yolo.js';

afterEach(async () => {
  await rm(yoloMarkerPath(), { force: true });
  delete process.env.OPENSQUID_YOLO;
});

async function run(args: string[]): Promise<string[]> {
  const lines: string[] = [];
  const program = new Command();
  program.exitOverride();
  registerYoloCli(program, { out: (l) => lines.push(l) });
  await program.parseAsync(['node', 'opensquid', 'yolo', ...args]);
  return lines;
}

describe('opensquid yolo (verb)', () => {
  it('on → writes marker (isYoloMode true); off → removes it (false)', async () => {
    await run(['on']);
    expect(await isYoloMode()).toBe(true);
    await run(['off']);
    expect(await isYoloMode()).toBe(false);
  });

  it('status (default) reports OFF then ON', async () => {
    expect((await run([])).join(' ')).toMatch(/OFF/);
    await run(['on']);
    expect((await run(['status'])).join(' ')).toMatch(/ON/);
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
