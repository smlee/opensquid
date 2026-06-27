/** `opensquid yolo on|off|status` — toggles the marker + reports state. */
import { rm } from 'node:fs/promises';

import { Command } from 'commander';
import { afterEach, describe, expect, it } from 'vitest';

import { registerYoloCli } from './yolo.js';
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

describe('opensquid yolo', () => {
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
