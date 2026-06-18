/** DAEMON.1 — runtime discovery state file. */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  readRuntimeState,
  runtimeStatePath,
  type RuntimeState,
  unlinkRuntimeState,
  writeRuntimeState,
} from './state_file.js';

let home: string;
const sample: RuntimeState = { port: 12345, token: 'tok-abc', pid: 999, startedAt: 1700000000000 };

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'osq-statefile-'));
});
afterEach(() => {
  /* tmp dirs are OS-reaped */
});

describe('runtime state file (DAEMON.1)', () => {
  it('write then read round-trips the discovery record', async () => {
    await writeRuntimeState(sample, home);
    expect(await readRuntimeState(home)).toEqual(sample);
  });

  it('absent file ⇒ null (client then auto-starts)', async () => {
    expect(await readRuntimeState(home)).toBeNull();
  });

  it('corrupt JSON ⇒ null (never throws)', async () => {
    await writeFile(runtimeStatePath(home), '{not json', 'utf8');
    expect(await readRuntimeState(home)).toBeNull();
  });

  it('present-but-partial (missing token) ⇒ null', async () => {
    await writeFile(
      runtimeStatePath(home),
      JSON.stringify({ port: 1, pid: 2, startedAt: 3 }),
      'utf8',
    );
    expect(await readRuntimeState(home)).toBeNull();
  });

  it('unlink removes the discovery file (idempotent)', async () => {
    await writeRuntimeState(sample, home);
    await unlinkRuntimeState(home);
    expect(await readRuntimeState(home)).toBeNull();
    await expect(unlinkRuntimeState(home)).resolves.toBeUndefined(); // absent is fine
  });

  it('writes a trailing newline (atomic, line-oriented)', async () => {
    await writeRuntimeState(sample, home);
    expect(await readFile(runtimeStatePath(home), 'utf8')).toMatch(/\}\n$/);
  });
});
