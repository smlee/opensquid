/**
 * Tests for the per-HOME actor id (WGD.1). `resolveActorId` generates a UUID on first use, persists it
 * atomically at `${OPENSQUID_HOME()}/actor-id`, caches it in-process, and is stable across re-reads.
 * Two distinct OPENSQUID_HOMEs (distinct device replicas) yield distinct ids. Module cache is reset
 * between cases via `vi.resetModules()` so the on-disk path (not the cache) is exercised.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let home: string;
const prevHome = process.env.OPENSQUID_HOME;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'actor-id-'));
  process.env.OPENSQUID_HOME = home;
  vi.resetModules();
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = prevHome;
  await rm(home, { recursive: true, force: true });
});

describe('resolveActorId (WGD.1)', () => {
  it('absent → generates a UUID and persists it at <home>/actor-id', async () => {
    const { resolveActorId } = await import('./actor_id.js');
    const id = await resolveActorId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const onDisk = (await readFile(join(home, 'actor-id'), 'utf8')).trim();
    expect(onDisk).toBe(id);
  });

  it('stable across re-reads: a fresh module load reads the SAME persisted id', async () => {
    const first = await (await import('./actor_id.js')).resolveActorId();
    vi.resetModules(); // drop the in-process cache → forces a disk read
    const second = await (await import('./actor_id.js')).resolveActorId();
    expect(second).toBe(first);
  });

  it('caches in-process (same value within one module instance)', async () => {
    const { resolveActorId } = await import('./actor_id.js');
    expect(await resolveActorId()).toBe(await resolveActorId());
  });

  it('two distinct OPENSQUID_HOMEs → distinct actor ids', async () => {
    const idA = await (await import('./actor_id.js')).resolveActorId();
    const otherHome = await mkdtemp(join(tmpdir(), 'actor-id-b-'));
    try {
      process.env.OPENSQUID_HOME = otherHome;
      vi.resetModules();
      const idB = await (await import('./actor_id.js')).resolveActorId();
      expect(idB).not.toBe(idA);
    } finally {
      await rm(otherHome, { recursive: true, force: true });
    }
  });

  it('an empty/whitespace actor-id file regenerates a fresh id', async () => {
    await writeFile(join(home, 'actor-id'), '   \n');
    const id = await (await import('./actor_id.js')).resolveActorId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect((await readFile(join(home, 'actor-id'), 'utf8')).trim()).toBe(id);
  });
});
