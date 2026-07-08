/** #26 — the PreToolUse wiring: GATED to Task* ticks (blast-radius), FAIL-OPEN on any dep error, and the
 *  BIDIRECTIONAL reconcile (inbound materialize + outbound nudge, shared op-log cursor). Deps are injected so
 *  no I/O / OPENSQUID_HOME is touched. HWS.5 wire coverage. */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  defaultOpenMap,
  runHarnessGraphSync,
  type HarnessGraphSyncDeps,
  type WgReconcileFacade,
} from './harness_graph_sync.js';
import { ccNudgeWriter, type HarnessWriter } from './harness_writer.js';
import type { HarnessTaskLike } from '../../workgraph/harness_sync.js';
import type { WgOp } from '../../workgraph/types.js';

const opSet = (issueId: string, lamport: number): WgOp => ({
  id: `op-${issueId}-${lamport}`,
  issueId,
  lamport,
  type: 'issue_set',
  payload: {},
  project: 'proj',
  actorId: 'a',
});

/** A work-graph facade whose issues are all pre-`closed`, plus an injectable op-log cursor (HWS.2). */
function closedWg(ops: WgOp[] = []): WgReconcileFacade & { hwValue: number } {
  const state = { hw: 0 };
  return {
    createIssue: ({ title }) => Promise.resolve({ id: `wg-${title}` }),
    getIssue: (id) => Promise.resolve({ id, status: 'closed', title: `title ${id}`, body: '' }),
    updateIssue: (id) => Promise.resolve(id),
    listOpsSince: (c) => Promise.resolve(ops.filter((o) => o.lamport > c)),
    readHighWater: () => Promise.resolve(state.hw),
    advanceHighWater: (l) => {
      state.hw = Math.max(state.hw, l);
      return Promise.resolve();
    },
    get hwValue() {
      return state.hw;
    },
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
        getByWgId: (p, wgId) => {
          for (const [k, v] of mapMem)
            if (v === wgId && k.startsWith(`${p} `)) return Promise.resolve(k.slice(p.length + 1));
          return Promise.resolve(null);
        },
      }),
    writer: ccNudgeWriter,
    ...over,
  };
}

describe('defaultOpenMap — PROJECT-LOCAL store (HWS.1, decision 5)', () => {
  const roots: string[] = [];
  const savedRoot = process.env.OPENSQUID_PROJECT_ROOT;
  afterEach(async () => {
    if (savedRoot === undefined) delete process.env.OPENSQUID_PROJECT_ROOT;
    else process.env.OPENSQUID_PROJECT_ROOT = savedRoot;
    while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
  });

  it('opens the map at <root>/.opensquid/harness_map.db, NOT OPENSQUID_HOME', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osq-proj-'));
    roots.push(root);
    await mkdir(join(root, '.opensquid'), { recursive: true }); // the store dir must exist for libSQL
    process.env.OPENSQUID_PROJECT_ROOT = root; // resolveLocalStoreDir override → <root>/.opensquid
    const map = await defaultOpenMap('no-session'); // readSessionCwd null → process.cwd(), overridden by env
    await map.bind('p', 'h1', 'wg-1'); // force a write so the db file materializes
    expect(existsSync(join(root, '.opensquid', 'harness_map.db'))).toBe(true); // project-local
    expect(await map.get('p', 'h1')).toBe('wg-1');
  });
});

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

  it('a throwing listOpsSince (cursor fault) resolves to null — fail-open at the reverse trigger', async () => {
    const wg = closedWg();
    wg.listOpsSince = () => Promise.reject(new Error('cursor down'));
    const r = await runHarnessGraphSync(
      's1',
      'TaskUpdate',
      { taskId: 'h1', status: 'in_progress' },
      't.jsonl',
      undefined,
      deps({ openWg: () => Promise.resolve(wg) }, [
        { id: 'h1', subject: 'x', status: 'in_progress' },
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
              getByWgId: (p, wgId) => {
                for (const [k, v] of mapMem)
                  if (v === wgId && k.startsWith(`${p} `))
                    return Promise.resolve(k.slice(p.length + 1));
                return Promise.resolve(null);
              },
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

  it('reconciles BOTH ways + advances the shared watermark to the max op lamport', async () => {
    // A wg-originated op on an unbound, non-harness-owned issue → a `create` outbound delta; the writer is
    // invoked with it and the watermark advances to the op's lamport.
    const wg = closedWg([opSet('wg-100', 7)]);
    wg.getIssue = (id) =>
      Promise.resolve({ id, status: 'open', title: 'hand-authored', body: 'backlog' });
    const writer: HarnessWriter & { calls: number } = {
      calls: 0,
      apply(d) {
        this.calls++;
        return Promise.resolve(d.length ? 'nudge' : null);
      },
    };
    const r = await runHarnessGraphSync(
      's1',
      'TaskCreate',
      {},
      't.jsonl',
      undefined,
      deps({ openWg: () => Promise.resolve(wg), writer }, [
        { id: 'h1', subject: 'x', status: 'pending' },
      ]),
    );
    expect(writer.calls).toBe(1);
    expect(r).toBe('nudge');
    expect(wg.hwValue).toBe(7); // watermark advanced to the max op lamport
  });

  it('no re-emit across triggers: after the watermark advances, a following tick sees no new ops', async () => {
    const wg = closedWg([opSet('wg-100', 4)]);
    wg.getIssue = (id) => Promise.resolve({ id, status: 'open', title: 't', body: 'backlog' });
    const d = deps({ openWg: () => Promise.resolve(wg) }, [
      { id: 'h1', subject: 'x', status: 'pending' },
    ]);
    await runHarnessGraphSync('s1', 'TaskCreate', {}, 't.jsonl', undefined, d);
    expect(wg.hwValue).toBe(4);
    // The SAME facade instance is reused (shared cursor); listOpsSince(4) is now empty.
    const seen: number[] = [];
    const r2 = await runHarnessGraphSync(
      's1',
      'TaskUpdate',
      { taskId: 'h1' },
      't.jsonl',
      undefined,
      {
        ...d,
        openWg: () => Promise.resolve(wg),
        writer: {
          apply: (deltas) => {
            seen.push(deltas.length);
            return Promise.resolve(deltas.length ? 'x' : null);
          },
        },
      },
    );
    expect(seen).toEqual([0]); // no new ops → empty outbound
    expect(r2).toBeNull();
  });
});
