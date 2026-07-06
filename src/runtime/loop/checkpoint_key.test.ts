/**
 * GS1 — resolveCheckpointKey: the canonical wg-issue-id resolver (lap vs interactive + null-skip).
 */
import { describe, expect, it } from 'vitest';

import { resolveCheckpointKey, type CheckpointKeyDeps } from './checkpoint_key.js';

function deps(over: Partial<CheckpointKeyDeps> = {}): CheckpointKeyDeps {
  return {
    itemId: () => undefined,
    readActiveTask: () => Promise.resolve(null),
    resolveProject: () => Promise.resolve('proj-1'),
    mapGet: () => Promise.resolve(null),
    ...over,
  };
}

describe('resolveCheckpointKey', () => {
  it('LAP: OPENSQUID_ITEM_ID present → returns it verbatim (the wg id), no I/O', async () => {
    let mapCalls = 0;
    const key = await resolveCheckpointKey(
      'sess',
      deps({
        itemId: () => 'wg-42',
        mapGet: () => {
          mapCalls++;
          return Promise.resolve('should-not-be-used');
        },
      }),
    );
    expect(key).toBe('wg-42');
    expect(mapCalls).toBe(0); // short-circuits before the forward map
  });

  it('INTERACTIVE: forward-maps the active harness task id → its bound wg issue id', async () => {
    const seen: { project?: string; harnessId?: string } = {};
    const key = await resolveCheckpointKey(
      'sess',
      deps({
        readActiveTask: () => Promise.resolve({ id: 'harness-7' }),
        resolveProject: () => Promise.resolve('proj-X'),
        mapGet: (project, harnessId) => {
          seen.project = project;
          seen.harnessId = harnessId;
          return Promise.resolve('wg-mapped-99');
        },
      }),
    );
    expect(key).toBe('wg-mapped-99');
    expect(seen).toEqual({ project: 'proj-X', harnessId: 'harness-7' }); // keyed on the HARNESS id
  });

  it('NULL-SKIP: no active task → null (skip the checkpoint write)', async () => {
    const key = await resolveCheckpointKey(
      'sess',
      deps({ readActiveTask: () => Promise.resolve(null) }),
    );
    expect(key).toBeNull();
  });

  it('NULL-SKIP: active task with NO wg binding yet (unmapped) → null (a later event creates it)', async () => {
    const key = await resolveCheckpointKey(
      'sess',
      deps({
        readActiveTask: () => Promise.resolve({ id: 'harness-unbound' }),
        mapGet: () => Promise.resolve(null),
      }),
    );
    expect(key).toBeNull();
  });

  it('LAP takes precedence over an active task (a lap never consults the map)', async () => {
    const key = await resolveCheckpointKey(
      'sess',
      deps({ itemId: () => 'wg-lap', readActiveTask: () => Promise.resolve({ id: 'harness-1' }) }),
    );
    expect(key).toBe('wg-lap');
  });
});
