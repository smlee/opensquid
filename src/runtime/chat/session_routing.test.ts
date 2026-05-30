/**
 * LL.2 — unit tests for the session-routing resolver. Time-injected `now`
 * for deterministic stale/fresh assertions; tmpdir OPENSQUID_HOME for
 * isolation.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { liveSessionLease } from '../paths.js';

import { resolveAllLiveProjects, resolveLiveSessionId } from './session_routing.js';

let tempHome: string;
let priorHome: string | undefined;

beforeEach(async () => {
  priorHome = process.env.OPENSQUID_HOME;
  tempHome = await mkdtemp(join(tmpdir(), 'opensquid-ll2-routing-'));
  process.env.OPENSQUID_HOME = tempHome;
});

afterEach(async () => {
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
  await rm(tempHome, { recursive: true, force: true });
});

async function seedLease(
  uuid: string,
  body: Record<string, unknown>,
  rawOverride?: string,
): Promise<void> {
  const path = liveSessionLease(uuid);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, rawOverride ?? JSON.stringify(body), 'utf8');
}

describe('resolveLiveSessionId — fresh / stale / missing / corrupt', () => {
  it('fresh lease (refreshed_at = now - 10s) → returns session_id', async () => {
    const now = new Date('2026-05-30T12:00:00Z');
    await seedLease('uuid-x', {
      session_id: 'sess-A',
      pid: 1,
      refreshed_at: new Date(now.getTime() - 10_000).toISOString(),
    });
    expect(await resolveLiveSessionId('uuid-x', now)).toBe('sess-A');
  });

  it('stale lease (refreshed_at = now - 120s) → returns null', async () => {
    const now = new Date('2026-05-30T12:00:00Z');
    await seedLease('uuid-x', {
      session_id: 'sess-A',
      pid: 1,
      refreshed_at: new Date(now.getTime() - 120_000).toISOString(),
    });
    expect(await resolveLiveSessionId('uuid-x', now)).toBeNull();
  });

  it('missing lease file → returns null', async () => {
    expect(await resolveLiveSessionId('uuid-absent', new Date())).toBeNull();
  });

  it('corrupt lease (empty object) → returns null', async () => {
    await seedLease('uuid-x', {});
    expect(await resolveLiveSessionId('uuid-x', new Date())).toBeNull();
  });

  it('lease with session_id: "" → returns null', async () => {
    const now = new Date('2026-05-30T12:00:00Z');
    await seedLease('uuid-x', {
      session_id: '',
      pid: 1,
      refreshed_at: now.toISOString(),
    });
    expect(await resolveLiveSessionId('uuid-x', now)).toBeNull();
  });

  it('clock-rewind (now < refreshed_at) → isLeaseFresh returns false → null', async () => {
    const baseline = new Date('2026-05-30T12:00:00Z');
    await seedLease('uuid-x', {
      session_id: 'sess-A',
      pid: 1,
      refreshed_at: baseline.toISOString(),
    });
    const earlierNow = new Date(baseline.getTime() - 10_000);
    expect(await resolveLiveSessionId('uuid-x', earlierNow)).toBeNull();
  });
});

describe('resolveAllLiveProjects — multi-project enumeration', () => {
  it('3 projects (2 fresh + 1 stale) → returns 2 sorted by refreshedAt', async () => {
    const now = new Date('2026-05-30T12:00:00Z');
    const tsFresh1 = new Date(now.getTime() - 60_000).toISOString();
    const tsFresh2 = new Date(now.getTime() - 30_000).toISOString();
    const tsStale = new Date(now.getTime() - 120_000).toISOString();
    await seedLease('uuid-a', { session_id: 'sess-A', pid: 1, refreshed_at: tsFresh1 });
    await seedLease('uuid-b', { session_id: 'sess-B', pid: 2, refreshed_at: tsFresh2 });
    await seedLease('uuid-c', { session_id: 'sess-C', pid: 3, refreshed_at: tsStale });

    const out = await resolveAllLiveProjects(now);
    expect(out).toHaveLength(2);
    expect(out.map((b) => b.projectUuid)).toEqual(['uuid-a', 'uuid-b']);
    expect(out[0]?.refreshedAt).toBe(tsFresh1);
    expect(out[1]?.refreshedAt).toBe(tsFresh2);
  });

  it('missing ~/.opensquid/projects/ → returns []', async () => {
    expect(await resolveAllLiveProjects(new Date())).toEqual([]);
  });
});
