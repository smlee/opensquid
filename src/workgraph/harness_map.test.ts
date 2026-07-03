/** #26 — the harness ↔ work-graph binding overlay: roundtrip, MONOTONIC (idempotent) bind, per-project
 *  isolation. Cloned from the kanban_cards overlay (`ON CONFLICT DO NOTHING`, `(project, key)` PK). */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { harnessMapStore, type HarnessMapStore } from './harness_map.js';

const dirs: string[] = [];
async function mk(): Promise<HarnessMapStore> {
  const dir = await mkdtemp(join(tmpdir(), 'osq-hmap-'));
  dirs.push(dir);
  const store = harnessMapStore(`file:${join(dir, 'h.db')}`);
  await store.init();
  return store;
}
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

describe('harnessMapStore', () => {
  it('bind + get roundtrip', async () => {
    const s = await mk();
    await s.bind('p1', 'h1', 'wg-1');
    expect(await s.get('p1', 'h1')).toBe('wg-1');
  });

  it('get returns null for an unbound harness id', async () => {
    const s = await mk();
    expect(await s.get('p1', 'nope')).toBeNull();
  });

  it('bind is MONOTONIC + idempotent — a re-bind never re-points (ON CONFLICT DO NOTHING)', async () => {
    const s = await mk();
    await s.bind('p1', 'h1', 'wg-1');
    await s.bind('p1', 'h1', 'wg-2'); // second binding must be a no-op
    expect(await s.get('p1', 'h1')).toBe('wg-1'); // first binding wins
  });

  it('is per-project scoped — the same harness id in two projects is isolated', async () => {
    const s = await mk();
    await s.bind('p1', 'h1', 'wg-a');
    await s.bind('p2', 'h1', 'wg-b');
    expect(await s.get('p1', 'h1')).toBe('wg-a');
    expect(await s.get('p2', 'h1')).toBe('wg-b');
  });

  it('init is idempotent — a second store over the same db keeps the bindings', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'osq-hmap-idem-'));
    dirs.push(dir);
    const url = `file:${join(dir, 'h.db')}`;
    const s1 = harnessMapStore(url);
    await s1.init();
    await s1.bind('p1', 'h1', 'wg-1');
    const s2 = harnessMapStore(url);
    await s2.init();
    expect(await s2.get('p1', 'h1')).toBe('wg-1');
  });
});
