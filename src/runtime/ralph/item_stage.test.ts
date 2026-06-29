/**
 * PSL.1 — the durable per-item loop stage (orchestration sidecar). Sandboxes OPENSQUID_HOME per test and proves
 * the round-trip: write→read, overwrite, clear→null, absent→null, and that an arbitrary item id is filesystem-safe.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { clearItemStage, readItemStage, writeItemStage } from './item_stage.js';

let home: string;
let prior: string | undefined;

beforeEach(async () => {
  prior = process.env.OPENSQUID_HOME;
  home = await mkdtemp(join(tmpdir(), 'opensquid-item-stage-'));
  process.env.OPENSQUID_HOME = home;
});
afterEach(async () => {
  if (prior === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = prior;
  await rm(home, { recursive: true, force: true });
});

describe('item_stage — durable per-item loop stage', () => {
  it('absent → null (a fresh item; the caller seeds the pack initial)', async () => {
    expect(await readItemStage('wg-abc')).toBeNull();
  });

  it('write → read round-trips, and a later write overwrites', async () => {
    await writeItemStage('wg-abc', 'plan');
    expect(await readItemStage('wg-abc')).toBe('plan');
    await writeItemStage('wg-abc', 'code'); // a later lap advanced it
    expect(await readItemStage('wg-abc')).toBe('code');
  });

  it('clear → null (the item left the loop)', async () => {
    await writeItemStage('wg-abc', 'author');
    await clearItemStage('wg-abc');
    expect(await readItemStage('wg-abc')).toBeNull();
  });

  it('clear on an absent item is a no-op (best-effort)', async () => {
    await expect(clearItemStage('wg-never')).resolves.toBeUndefined();
  });

  it('a realistic content-addressed work-graph id (wg-<hex>) round-trips', async () => {
    const id = 'wg-1a2b3c4d5e6f';
    await writeItemStage(id, 'scope');
    expect(await readItemStage(id)).toBe('scope');
  });

  it('a path-unsafe id is REJECTED (safeRecordId guard — real wg ids are never unsafe)', async () => {
    await expect(writeItemStage('wg/../escape', 'scope')).rejects.toThrow(/unsafe record id/);
  });
});
