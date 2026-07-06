/** #26 — the PreToolUse wiring: GATED to Task* ticks (blast-radius), FAIL-OPEN on any dep error, and the
 *  outbound reconcile instruction wiring. Deps are injected so no I/O / OPENSQUID_HOME is touched. */
import { describe, expect, it, vi } from 'vitest';

import { runHarnessGraphSync, type HarnessGraphSyncDeps } from './harness_graph_sync.js';
import type { HarnessTaskLike, WgSyncFacade } from '../../workgraph/harness_sync.js';

/** A work-graph facade whose issues are all pre-`closed` (so an open harness task → stale-open nudge). */
function closedWg(): WgSyncFacade {
  return {
    createIssue: ({ title }) => Promise.resolve({ id: `wg-${title}` }),
    getIssue: (id) => Promise.resolve({ id, status: 'closed' }),
    updateIssue: (id) => Promise.resolve(id),
  };
}

function deps(
  over: Partial<HarnessGraphSyncDeps> = {},
  tasks: HarnessTaskLike[] = [],
): HarnessGraphSyncDeps {
  const mapMem = new Map<string, string>();
  return {
    readTasks: () => Promise.resolve(tasks),
    resolveProject: () => Promise.resolve('proj'),
    openWg: () => Promise.resolve(closedWg()),
    openMap: () =>
      Promise.resolve({
        get: (p, h) => Promise.resolve(mapMem.get(`${p} ${h}`) ?? null),
        bind: (p, h, w) => {
          mapMem.set(`${p} ${h}`, w);
          return Promise.resolve();
        },
      }),
    ...over,
  };
}

describe('runHarnessGraphSync — gating (blast-radius)', () => {
  it('does NOT fire on a non-task tool (returns null, never reads/opens anything)', async () => {
    const readTasks = vi.fn();
    const openWg = vi.fn();
    const r = await runHarnessGraphSync(
      's1',
      'Bash',
      { command: 'ls' },
      undefined,
      undefined,
      deps({
        readTasks: readTasks as unknown as HarnessGraphSyncDeps['readTasks'],
        openWg: openWg as unknown as HarnessGraphSyncDeps['openWg'],
      }),
    );
    expect(r).toBeNull();
    expect(readTasks).not.toHaveBeenCalled();
    expect(openWg).not.toHaveBeenCalled();
  });

  it.each(['TaskCreate', 'TaskUpdate'])('DOES fire on %s (reads the task list)', async (tool) => {
    const readTasks = vi.fn().mockResolvedValue([]);
    await runHarnessGraphSync(
      's1',
      tool,
      {},
      undefined,
      undefined,
      deps({
        readTasks: readTasks as unknown as HarnessGraphSyncDeps['readTasks'],
      }),
    );
    expect(readTasks).toHaveBeenCalledOnce();
  });
});

describe('runHarnessGraphSync — fail-open', () => {
  it('a throwing readTasks resolves to null (never throws into the hook)', async () => {
    const r = await runHarnessGraphSync(
      's1',
      'TaskUpdate',
      { taskId: 'h1', status: 'completed' },
      't.jsonl',
      undefined,
      deps({
        readTasks: () => Promise.reject(new Error('boom')),
      }),
    );
    expect(r).toBeNull();
  });

  it('a throwing openWg resolves to null', async () => {
    const r = await runHarnessGraphSync(
      's1',
      'TaskCreate',
      {},
      't.jsonl',
      undefined,
      deps({ openWg: () => Promise.reject(new Error('db down')) }, [
        { id: 'h1', subject: 'x', status: 'pending' },
      ]),
    );
    expect(r).toBeNull();
  });
});

describe('runHarnessGraphSync — outbound reconcile instruction', () => {
  it('emits a TaskUpdate nudge when a bound wg issue is closed but the task is still open', async () => {
    const mapMem = new Map<string, string>([['proj h1', 'wg-closed']]); // already bound to a closed issue
    const r = await runHarnessGraphSync(
      's1',
      'TaskUpdate',
      { taskId: 'h1', status: 'in_progress' },
      't.jsonl',
      undefined,
      deps(
        {
          openMap: () =>
            Promise.resolve({
              get: (p, h) => Promise.resolve(mapMem.get(`${p} ${h}`) ?? null),
              bind: () => Promise.resolve(),
            }),
        },
        [{ id: 'h1', subject: 'still going', status: 'in_progress' }],
      ),
    );
    expect(r).not.toBeNull();
    expect(r).toContain('#h1');
    expect(r).toContain('TaskUpdate');
    expect(r).toContain('completed');
  });

  it('returns null when there is nothing to reconcile (empty task list)', async () => {
    const r = await runHarnessGraphSync('s1', 'TaskCreate', {}, 't.jsonl', undefined, deps({}, []));
    expect(r).toBeNull();
  });
});
