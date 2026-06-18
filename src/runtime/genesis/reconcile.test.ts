/** GR.1 — genesis reconcile driver + shutdown marker. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { reconcile, type GenesisClassifier, type ReconcileDescriptor } from './reconcile.js';
import {
  consumeShutdownMarker,
  readShutdownMarker,
  writeShutdownMarker,
} from './shutdown_marker.js';

const cleanMarker: GenesisClassifier = {
  shutdownMarker: async () => ({ status: 'clean', digest: 'd', ts: 1 }),
};
const crashMarker: GenesisClassifier = { shutdownMarker: async () => null };

function desc(
  over: Partial<ReconcileDescriptor<unknown>> & { actor: string },
): ReconcileDescriptor<unknown> {
  return {
    read: async () => null,
    classify: () => 'new_start',
    entry: (c) => ({ mode: c }),
    ...over,
  };
}

describe('reconcile (GR.1)', () => {
  it('is total: every descriptor yields exactly one EntryPlan, with hierarchical resume state', async () => {
    const { plan, report } = await reconcile(
      [
        desc({ actor: 'a', classify: () => 'new_start', entry: () => ({ mode: 'new_start' }) }),
        desc({
          actor: 'b',
          read: async () => ({ current: 's' }),
          classify: () => 'resume',
          entry: () => ({ mode: 'resume', state: 'build/backend_api' }),
        }),
      ],
      cleanMarker,
    );
    expect(Object.keys(plan)).toEqual(['a', 'b']);
    expect(plan.b?.state).toBe('build/backend_api');
    expect(report.actors).toEqual({ a: 'new_start', b: 'resume' });
  });

  it('crash (no marker) → recovery=true; clean (marker) → recovery=false', async () => {
    expect((await reconcile([desc({ actor: 'a' })], crashMarker)).recovery).toBe(true);
    expect((await reconcile([desc({ actor: 'a' })], cleanMarker)).recovery).toBe(false);
  });

  it('a connected pack failing validate → wedge + disabled + a failure entry', async () => {
    const { plan, report } = await reconcile(
      [
        desc({
          actor: 'p',
          read: async () => ({ v: 1 }),
          classify: () => 'resume',
          validate: () => ({ ok: false, reason: 'version mismatch' }),
          entry: () => ({ mode: 'resume' }),
        }),
      ],
      cleanMarker,
    );
    expect(plan.p).toMatchObject({ mode: 'wedge', reason: 'version mismatch' });
    expect(report.packs.p).toEqual({ disabled: 'version mismatch' });
    expect(report.failures).toEqual([{ actor: 'p', reason: 'version mismatch' }]);
  });

  it('a pack that validates → connected', async () => {
    const { report } = await reconcile(
      [
        desc({
          actor: 'p',
          read: async () => ({ v: 1 }),
          classify: () => 'resume',
          validate: () => ({ ok: true }),
          entry: () => ({ mode: 'resume' }),
        }),
      ],
      cleanMarker,
    );
    expect(report.packs.p).toBe('connected');
  });
});

describe('shutdown marker (GR.1)', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'osq-marker-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('write → read round-trips clean', async () => {
    await writeShutdownMarker('digest-1', home);
    expect(await readShutdownMarker(home)).toMatchObject({ status: 'clean', digest: 'digest-1' });
  });

  it('consume is one-shot: a second consume sees a crash (null)', async () => {
    await writeShutdownMarker('d', home);
    expect(await consumeShutdownMarker(home)).not.toBeNull();
    expect(await consumeShutdownMarker(home)).toBeNull();
  });

  it('absent marker → null (crash)', async () => {
    expect(await readShutdownMarker(home)).toBeNull();
  });
});
