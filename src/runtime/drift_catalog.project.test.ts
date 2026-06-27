/**
 * T-project-drift-counter — the PROJECT-scoped drift catalog + by-TYPE counter, and proof the LIVE
 * dispatcher records a real gate drift into the project catalog (so the counter reflects gate activity).
 */
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  appendProjectDriftEvent,
  readProjectDriftCatalog,
  countDriftsByType,
  projectDriftCounts,
  type DriftEvent,
} from './drift_catalog.js';
import { loadPack } from '../packs/loader.js';
import { buildRegistry } from './bootstrap.js';
import { dispatchEvent } from './hooks/dispatch.js';
import type { Event } from './types.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'osq-pdrift-'));
  await mkdir(join(root, '.opensquid'), { recursive: true }); // project-scope marker
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const ev = (ruleId: string, level: string): DriftEvent => ({
  timestamp: '2026-06-27T00:00:00.000Z',
  pack: 'p',
  ruleId,
  level,
  message: 'm',
});

describe('countDriftsByType (pure)', () => {
  it('tallies by ruleId with a per-level breakdown, most-frequent first', () => {
    const counts = countDriftsByType([
      ev('a', 'warn'),
      ev('a', 'block'),
      ev('a', 'warn'),
      ev('b', 'block'),
    ]);
    expect(counts).toEqual([
      { ruleId: 'a', count: 3, byLevel: { warn: 2, block: 1 } },
      { ruleId: 'b', count: 1, byLevel: { block: 1 } },
    ]);
  });
  it('empty → []', () => expect(countDriftsByType([])).toEqual([]));
});

describe('project drift catalog (append/read/count)', () => {
  it('round-trips events into the project catalog + counts by type', async () => {
    await appendProjectDriftEvent(root, ev('guard:x', 'warn'));
    await appendProjectDriftEvent(root, ev('guard:x', 'block'));
    expect(await readProjectDriftCatalog(root)).toHaveLength(2);
    expect(await projectDriftCounts(root)).toEqual([
      { ruleId: 'guard:x', count: 2, byLevel: { warn: 1, block: 1 } },
    ]);
  });
  it('no project scope (no .opensquid ancestor) → no-op write + empty read', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'osq-noscope-'));
    await appendProjectDriftEvent(bare, ev('a', 'warn')); // no-op
    expect(await readProjectDriftCatalog(bare)).toEqual([]);
    await rm(bare, { recursive: true, force: true });
  });
});

describe('LIVE dispatch records a real gate drift into the project catalog', () => {
  it('a blocked `git commit` records the firing gate (by type) in the project counter', async () => {
    const pack = await loadPack(resolve('packs/builtin/default-discipline'));
    const registry = await buildRegistry({
      backend: {
        init: () => Promise.resolve(),
        embed: () => Promise.resolve(null),
        recall: () => Promise.resolve([]),
        storeLesson: () => Promise.resolve(),
        deleteLesson: () => Promise.resolve({ deleted: false, forced: false }),
      },
    });
    const event = {
      kind: 'tool_call',
      tool: 'Bash',
      args: { command: 'git commit -m x' }, // no phases logged → phase-logged-before-commit blocks
      cwd: root, // → project scope = root/.opensquid
    } as unknown as Event;

    const d = await dispatchEvent(event, [pack], registry, 'pdrift-sid');
    expect(d.exitCode).toBe(2); // a discipline gate blocked the commit

    // The LIVE dispatch recorded the firing gate into the PROJECT catalog, counted by type (ruleId).
    const counts = await projectDriftCounts(root);
    const blocked = counts.find((c) => c.ruleId === 'phase-logged-before-commit');
    expect(blocked?.count).toBe(1);
    expect(blocked?.byLevel.block).toBe(1);
  });
});
