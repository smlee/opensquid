import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runRalphLoop, resolveParked, type RalphConfig, type RalphDeps } from './orchestrator.js';
import type { Issue, WorkGraphFacade } from '../../workgraph/types.js';
import type { LapResult } from './supervisor.js';
import type { LoopMetricRow } from '../loop/loop_metrics.js';
import { tailEventsSince } from '../loop/loop_events.js';

// LMP.2 — the SHIPPED/wedge paths push monitor events (fail-open). Isolate every emit to a temp project-local
// store (OPENSQUID_PROJECT_ROOT) so the loop's emits never touch the real dev store, and so the item_shipped /
// item_wedged assertions below read an isolated log.
const savedRoot = process.env.OPENSQUID_PROJECT_ROOT;
let projectRoot: string;
beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'orchestrator-'));
  mkdirSync(join(projectRoot, '.opensquid'), { recursive: true });
  process.env.OPENSQUID_PROJECT_ROOT = projectRoot;
});
afterEach(() => {
  if (savedRoot === undefined) delete process.env.OPENSQUID_PROJECT_ROOT;
  else process.env.OPENSQUID_PROJECT_ROOT = savedRoot;
  rmSync(projectRoot, { recursive: true, force: true });
});

const P = <T>(v: T): Promise<T> => Promise.resolve(v);

// ---- minimal in-memory work-graph: just the surface runRalphLoop touches ----
// listReady returns open, non-wedged, non-live-claimed items oldest-first; claim/close/wedge mutate
// state so the loop terminates naturally (the real store's invariants, in miniature).
function mockStore(ids: string[], claimLost = new Set<string>()): WorkGraphFacade {
  const rows = new Map<
    string,
    { status: 'open' | 'closed' | 'archived'; wedged: boolean; claimed: boolean }
  >();
  ids.forEach((id) => rows.set(id, { status: 'open', wedged: false, claimed: false }));
  const issue = (id: string): Issue => ({
    id,
    title: id,
    body: '',
    status: rows.get(id)!.status,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...(rows.get(id)!.wedged ? { wedgeReason: 'UNRECOVERABLE_WEDGE' } : {}),
  });
  const store: WorkGraphFacade = {
    listReady: () =>
      P(
        ids
          .filter((id) => {
            const r = rows.get(id)!;
            return r.status === 'open' && !r.wedged && !r.claimed;
          })
          .map(issue),
      ),
    claimIssue: (id: string) => {
      rows.get(id)!.claimed = true; // either way it now carries a live claim → excluded next pass
      return P(
        claimLost.has(id)
          ? { won: false, expiresAt: '' }
          : { won: true, expiresAt: '2026-01-01T00:30:00.000Z' },
      );
    },
    updateIssue: (id: string, patch: { status?: 'open' | 'closed' }) => {
      if (patch.status) rows.get(id)!.status = patch.status;
      return P(issue(id));
    },
    wedgeMark: (id: string) => {
      rows.get(id)!.wedged = true;
      return P(undefined);
    },
    clearWedge: (id: string) => {
      rows.get(id)!.wedged = false;
      return P(undefined);
    },
    releaseClaim: (id: string) => {
      rows.get(id)!.claimed = false;
      return P(undefined);
    },
    // unused by the loop — present to satisfy the facade interface
    createIssue: () => P(issue(ids[0] ?? 'x')),
    getIssue: (id: string) => P(rows.has(id) ? issue(id) : null),
    listIssues: () => P(ids.map(issue)),
    addEdge: () => P(undefined),
    archiveIssue: (id: string) => {
      rows.get(id)!.status = 'archived';
      return P(undefined);
    },
    unarchiveIssue: (id: string) => {
      rows.get(id)!.status = 'open';
      return P(undefined);
    },
    listEvents: () => P([]),
    listEdges: () => P([]),
    listOpsSince: () => P([]),
    readHighWater: () => P(0),
    advanceHighWater: () => P(undefined),
  };
  return store;
}

const cfg = (over: Partial<RalphConfig> = {}): RalphConfig => ({
  authMode: 'subscription',
  maxBudgetUsd: 100,
  claimTtlSec: 1800,
  supervise: {
    maxRetries: 0,
    backoffMs: () => 0,
    heartbeat: () => undefined,
    sleep: () => P(undefined),
  },
  harness: 'claude',
  runId: 'run-test',
  ...over,
});

const deps = (
  wg: WorkGraphFacade,
  runLap: RalphDeps['runLap'],
  escalate: RalphDeps['escalate'] = vi.fn(() => P({ escalated: true })),
): RalphDeps => ({ wg, claimAudience: () => ({ source: 'unknown' }), runLap, escalate });

const lap = (o: LapResult) => vi.fn(() => P(o));

describe('runRalphLoop', () => {
  it('empty board → BOARD_EMPTY, escalated, no lap spawned', async () => {
    const runLap = lap({ kind: 'SHIPPED', costUsd: 0 });
    const esc = vi.fn(() => P({ escalated: true }));
    const r = await runRalphLoop(cfg(), deps(mockStore([]), runLap, esc));
    expect(r.stopped).toBe('BOARD_EMPTY');
    expect(runLap).not.toHaveBeenCalled();
    expect(esc).toHaveBeenCalledTimes(1); // BOARD_EMPTY DOES escalate (not a silent stop)
  });

  it('one ready item, lap SHIPPED → item closed, loop closes it → drains to BOARD_EMPTY', async () => {
    const runLap = lap({ kind: 'SHIPPED', costUsd: 0.04 });
    const r = await runRalphLoop(cfg(), deps(mockStore(['a']), runLap));
    expect(r.stopped).toBe('BOARD_EMPTY');
    expect(r.closed).toEqual(['a']);
    expect(r.parked).toEqual([]);
    expect(r.spent).toBeCloseTo(0.04);
  });

  it('T2.9: calls onShipped(taskId) after a SHIPPED lap (the loop-driver live caller)', async () => {
    const runLap = lap({ kind: 'SHIPPED', costUsd: 0 });
    const onShipped = vi.fn(() => P(undefined));
    await runRalphLoop(cfg(), {
      ...deps(mockStore(['a']), runLap),
      onShipped,
    });
    expect(onShipped).toHaveBeenCalledWith('a');
  });

  it('T2.9: a throwing onShipped does NOT break the drain — the item still closes (fail-open)', async () => {
    const runLap = lap({ kind: 'SHIPPED', costUsd: 0 });
    const onShipped = vi.fn(() => Promise.reject(new Error('report boom')));
    const r = await runRalphLoop(cfg(), {
      ...deps(mockStore(['a']), runLap),
      onShipped,
    });
    expect(r.closed).toEqual(['a']); // closed despite the hook throwing
  });

  it('lap HUMAN_REQUIRED{SCOPE_FORK} → escalate + wedge-mark, loop proceeds then BOARD_EMPTY', async () => {
    const esc = vi.fn(() => P({ escalated: true }));
    const runLap = lap({ kind: 'HUMAN_REQUIRED', reason: 'SCOPE_FORK', costUsd: 0.01 });
    const r = await runRalphLoop(cfg(), deps(mockStore(['a']), runLap, esc));
    expect(r.parked).toEqual([{ id: 'a', reason: 'SCOPE_FORK' }]);
    expect(r.closed).toEqual([]);
    expect(r.stopped).toBe('BOARD_EMPTY'); // a wedge-marked → drops out → board empty
    expect(esc).toHaveBeenCalledTimes(2); // once for SCOPE_FORK, once for BOARD_EMPTY
  });

  it('lap WEDGE → wedge-mark UNRECOVERABLE_WEDGE + escalate, does not stop the loop', async () => {
    const runLap = lap({ kind: 'WEDGE', costUsd: 0.02 });
    const r = await runRalphLoop(cfg(), deps(mockStore(['a']), runLap));
    expect(r.parked).toEqual([{ id: 'a', reason: 'UNRECOVERABLE_WEDGE' }]);
    expect(r.stopped).toBe('BOARD_EMPTY'); // continued past the wedge to an empty board
  });

  it('API budget exceeded → BUDGET escalate + STOP', async () => {
    const runLap = lap({ kind: 'SHIPPED', costUsd: 5 });
    const r = await runRalphLoop(
      cfg({ authMode: 'api', maxBudgetUsd: 1 }),
      deps(mockStore(['a', 'b']), runLap),
    );
    expect(r.stopped).toBe('BUDGET');
    expect(r.closed).toEqual(['a']); // a shipped, then budget tripped before b
    expect(r.spent).toBe(5);
  });

  it('claimIssue won:false → item skipped (no lap), excluded next pass → BOARD_EMPTY', async () => {
    const runLap = lap({ kind: 'SHIPPED', costUsd: 0 });
    const r = await runRalphLoop(cfg(), deps(mockStore(['a'], new Set(['a'])), runLap));
    expect(runLap).not.toHaveBeenCalled();
    expect(r.stopped).toBe('BOARD_EMPTY');
  });

  it('lap-emitted RATE_BUDGET (transient resource pause) → escalate + STOP, item NOT wedge-marked (retries)', async () => {
    const esc = vi.fn(() => P({ escalated: true }));
    const wg = mockStore(['a', 'b']);
    const runLap = lap({ kind: 'HUMAN_REQUIRED', reason: 'RATE_BUDGET', costUsd: 0.01 });
    const r = await runRalphLoop(cfg(), deps(wg, runLap, esc));
    expect(r.stopped).toBe('RATE_BUDGET');
    expect(r.parked).toEqual([]); // a TRANSIENT pause must NOT permanently park the item
    expect(esc).toHaveBeenCalledTimes(1); // still escalates (no silent stop)
    expect((await wg.getIssue('a'))?.wedgeReason).toBeUndefined(); // NOT wedged → re-surfaces once the claim expires
  });

  it('undroppable escalation: a RESIDUAL delivery failure throws (no silent drop — Inv 6)', async () => {
    // A per-item wedge (SCOPE_FORK) with a failing transport MUST crash the loop — the human can never
    // silently lose a wedged item. (Resource pauses are the exception; see the next test.)
    const runLap = lap({ kind: 'HUMAN_REQUIRED', reason: 'SCOPE_FORK', costUsd: 0 });
    const failEsc = vi.fn(() => P({ escalated: false, reason: 'no channel' }));
    await expect(runRalphLoop(cfg(), deps(mockStore(['a']), runLap, failEsc))).rejects.toThrow(
      /UNDELIVERABLE/,
    );
  });

  it('resource-pause escalation is FAIL-OPEN on delivery: BOARD_EMPTY + a failing transport does NOT throw — loop stops cleanly', async () => {
    // The original bug: the escalation channel was undeliverable, so BOARD_EMPTY threw EscalationUndeliverable
    // and the loop exited 1. A transient clean stop must survive an undeliverable notice (daemon down / no
    // chat binding) — it still ATTEMPTS to escalate (not a silent stop), then stops cleanly.
    const runLap = lap({ kind: 'SHIPPED', costUsd: 0 });
    const failEsc = vi.fn(() => P({ escalated: false, reason: 'chat-daemon unreachable' }));
    const r = await runRalphLoop(cfg(), deps(mockStore([]), runLap, failEsc));
    expect(r.stopped).toBe('BOARD_EMPTY');
    expect(failEsc).toHaveBeenCalledTimes(1); // it DID attempt delivery — fail-open, not fail-silent
  });
});

describe('runRalphLoop — LMP.2 monitor emits (push feed)', () => {
  it('a SHIPPED lap pushes an item_shipped event (the pushed close event — staleness fix)', async () => {
    const runLap = lap({ kind: 'SHIPPED', costUsd: 0 });
    await runRalphLoop(cfg(), deps(mockStore(['wg-a']), runLap));
    const events = await tailEventsSince(0);
    const shipped = events.filter((e) => e.kind === 'item_shipped');
    expect(shipped.map((e) => e.wgId)).toContain('wg-a');
  });

  it('a wedged lap pushes an item_wedged event (guarded on a present item)', async () => {
    const runLap = lap({ kind: 'WEDGE', costUsd: 0 });
    await runRalphLoop(cfg(), deps(mockStore(['wg-w']), runLap));
    const events = await tailEventsSince(0);
    const wedged = events.filter((e) => e.kind === 'item_wedged');
    expect(wedged.map((e) => e.wgId)).toEqual(['wg-w']);
  });

  it('BOARD_EMPTY (item-less park) pushes NO item-keyed event', async () => {
    const runLap = lap({ kind: 'SHIPPED', costUsd: 0 });
    await runRalphLoop(cfg(), deps(mockStore([]), runLap)); // empty board → BOARD_EMPTY only
    const events = await tailEventsSince(0);
    // no item_wedged/closed/shipped from an item-less BOARD_EMPTY park (there is nothing to key).
    expect(events).toEqual([]);
  });
});

describe('resolveParked (human-override residual-shrink path)', () => {
  it('on a wedge-marked item → records misclassification (DECIDE/ESCALATE) + un-wedges', async () => {
    const wg = mockStore(['a']);
    await wg.wedgeMark('a', 'UNRECOVERABLE_WEDGE'); // parked
    const rec = vi.fn(() => P(undefined));
    await resolveParked('a', { wg, recordMisclassification: rec, sessionId: 's1', nowIso: 'now' });
    expect(rec).toHaveBeenCalledWith('s1', 'DECIDE', 'ESCALATE', 'a', 'now'); // expected vs got
    expect((await wg.listReady()).map((i) => i.id)).toEqual(['a']); // un-wedged → back in ready
  });

  it('also RELEASES the lap claim → un-wedged item re-surfaces NOW, not at TTL (wg-8e1104f1934b)', async () => {
    const wg = mockStore(['a']);
    await wg.claimIssue('a', { source: 'claudecode', version: '1.2.3' }, 1800); // the lap claimed it
    await wg.wedgeMark('a', 'UNRECOVERABLE_WEDGE'); // then parked it
    expect((await wg.listReady()).map((i) => i.id)).not.toContain('a'); // wedged + claimed → excluded
    const rec = vi.fn(() => P(undefined));
    await resolveParked('a', { wg, recordMisclassification: rec, sessionId: 's1', nowIso: 'now' });
    expect((await wg.listReady()).map((i) => i.id)).toContain('a'); // claim released → ready WITHOUT TTL wait
  });

  it('on a NON-parked item (no wedgeReason) → throws, no misclassification recorded', async () => {
    const wg = mockStore(['a']);
    const rec = vi.fn(() => P(undefined));
    await expect(
      resolveParked('a', { wg, recordMisclassification: rec, sessionId: 's1', nowIso: 'now' }),
    ).rejects.toThrow(/not a parked item/);
    expect(rec).not.toHaveBeenCalled();
  });
});

// ---- PSL.3 / GS1 — the per-stage subprocess loop (each automated stage = its own fresh-context lap) ----
// GS1: `scope` is human-boundary (interactive); `scope_write` is the first AUTOMATED stage.
// T-active-task-mirror E: a fresh item now seeds at `scope_write` (the FSM write-through owns the durable stage,
// so the stub no longer takes a `writeStage`; the scope gate defaults to 'drive').
const AUTOMATED = new Set(['scope_write', 'plan', 'author', 'code']);
/** A stageLoop driver over an in-memory durable-stage store; stagePrompt = `DO <stage>` (the test reads it back). */
function stageLoopStub(
  store = new Map<string, string>(),
  scopeGate: (item: Issue) => Promise<'drive' | 'hold'> = () => P('drive'),
): NonNullable<RalphDeps['stageLoop']> {
  return {
    initialStage: 'scope_write',
    isAutomated: (s: string) => AUTOMATED.has(s),
    stagePrompt: (_item: Issue, stage: string) => P(`DO ${stage}`),
    readStage: (id: string) => P(store.get(id) ?? null),
    clearStage: (id: string) => {
      store.delete(id);
      return P(undefined);
    },
    scopeGate,
  };
}

describe('runRalphLoop — PSL.3 per-stage loop', () => {
  it('drives each automated stage as its own lap (advancing via the reported stage), then the boundary lap', async () => {
    // T-active-task-mirror E: a fresh item seeds at `scope_write` (the first AUTOMATED stage) — no initial human
    // scope lap. Flow: scope_write/plan/author/code (automated) → deploy (human boundary, no stage = done).
    const advance: Record<string, string> = {
      scope_write: 'plan',
      plan: 'author',
      author: 'code',
      code: 'deploy',
    };
    const calls: (string | undefined)[] = [];
    const store = new Map<string, string>();
    const runLap = vi.fn((_item: Issue, sp?: string) => {
      calls.push(sp);
      // The deploy/accept boundary lap (sp undefined): no stage = item complete.
      if (sp === undefined) return P<LapResult>({ kind: 'SHIPPED', costUsd: 0.01 });
      const next = advance[sp.replace('DO ', '')];
      return P<LapResult>(
        next === undefined
          ? { kind: 'SHIPPED', costUsd: 0.01 }
          : { kind: 'SHIPPED', stage: next, costUsd: 0.01 },
      );
    });
    const r = await runRalphLoop(cfg(), {
      ...deps(mockStore(['a']), runLap),
      stageLoop: stageLoopStub(store),
    });
    // 4 automated laps (scope_write/plan/author/code) + 1 human deploy boundary lap = 5
    expect(calls).toEqual(['DO scope_write', 'DO plan', 'DO author', 'DO code', undefined]);
    expect(r.closed).toEqual(['a']);
    expect(r.spent).toBeCloseTo(0.05);
    expect(store.has('a')).toBe(false); // clearStage on close
  });

  it('LSF.5 — records ONE per-stage metrics row per stage with the folded cost/tokens/harness/runId', async () => {
    const advance: Record<string, string> = {
      scope_write: 'plan',
      plan: 'author',
      author: 'code',
      code: 'deploy',
    };
    const runLap = vi.fn((_item: Issue, sp?: string) => {
      if (sp === undefined)
        return P<LapResult>({ kind: 'SHIPPED', costUsd: 0.02, inputTokens: 5, outputTokens: 2 });
      const next = advance[sp.replace('DO ', '')];
      return P<LapResult>(
        next === undefined
          ? { kind: 'SHIPPED', costUsd: 0.02, inputTokens: 5, outputTokens: 2 }
          : { kind: 'SHIPPED', stage: next, costUsd: 0.02, inputTokens: 5, outputTokens: 2 },
      );
    });
    const rows: LoopMetricRow[] = [];
    await runRalphLoop(cfg({ harness: 'codex', runId: 'run-xyz', authMode: 'api' }), {
      ...deps(mockStore(['a']), runLap),
      stageLoop: stageLoopStub(new Map<string, string>()),
      recordMetric: (row) => {
        rows.push(row);
        return P(undefined);
      },
    });
    // one row per stage the drive passed through: scope_write, plan, author, code, then the deploy boundary.
    expect(rows.map((r) => r.stage)).toEqual(['scope_write', 'plan', 'author', 'code', 'deploy']);
    for (const r of rows) {
      expect(r).toMatchObject({
        runId: 'run-xyz',
        itemId: 'a',
        harness: 'codex',
        authMode: 'api',
        costUsd: 0.02,
        inputTokens: 5,
        outputTokens: 2,
      });
      expect(r.endedAtMs).toBeGreaterThanOrEqual(r.startedAtMs);
      expect(r.durationMs).toBe(r.endedAtMs - r.startedAtMs);
    }
  });

  it('LSF.5 — a stuck stage is metriced ONCE (SUM of its retry laps) before the wedge', async () => {
    const runLap = vi.fn(() =>
      P<LapResult>({
        kind: 'SHIPPED',
        stage: 'scope_write',
        costUsd: 0.01,
        inputTokens: 3,
        outputTokens: 1,
      }),
    );
    const rows: LoopMetricRow[] = [];
    await runRalphLoop(cfg(), {
      ...deps(mockStore(['a']), runLap),
      stageLoop: stageLoopStub(),
      recordMetric: (row) => {
        rows.push(row);
        return P(undefined);
      },
    });
    expect(rows).toHaveLength(1); // one row for the stuck stage
    expect(rows[0]).toMatchObject({ stage: 'scope_write', inputTokens: 30, outputTokens: 10 });
    expect(rows[0]?.costUsd).toBeCloseTo(0.1, 5); // SUM of the 10 retry laps (0.01 each)
  });

  it('LSF.5 — a recordMetric throw is swallowed (fail-open; the drive still ships)', async () => {
    const runLap = vi.fn((_item: Issue, sp?: string) =>
      P<LapResult>(
        sp === undefined ? { kind: 'SHIPPED', costUsd: 0 } : { kind: 'SHIPPED', costUsd: 0 },
      ),
    );
    const store = new Map<string, string>([['a', 'deploy']]);
    const r = await runRalphLoop(cfg(), {
      ...deps(mockStore(['a']), runLap),
      stageLoop: stageLoopStub(store),
      recordMetric: () => Promise.reject(new Error('db down')),
    });
    expect(r.closed).toEqual(['a']); // the metrics fault never broke the drive
  });

  it('resumes from the DURABLE stage, not the pack initial', async () => {
    const store = new Map<string, string>([['a', 'author']]); // a prior run left it at author
    const calls: (string | undefined)[] = [];
    const advance: Record<string, string> = { author: 'code', code: 'deploy' };
    const runLap = vi.fn((_item: Issue, sp?: string) => {
      calls.push(sp);
      if (sp === undefined) return P<LapResult>({ kind: 'SHIPPED', costUsd: 0 });
      const next = advance[sp.replace('DO ', '')];
      return P<LapResult>(
        next === undefined
          ? { kind: 'SHIPPED', costUsd: 0 }
          : { kind: 'SHIPPED', stage: next, costUsd: 0 },
      );
    });
    await runRalphLoop(cfg(), {
      ...deps(mockStore(['a']), runLap),
      stageLoop: stageLoopStub(store),
    });
    expect(calls).toEqual(['DO author', 'DO code', undefined]); // started at author, NOT scope
  });

  it('an item already past the automated stages goes straight to the open-ended boundary lap', async () => {
    const store = new Map<string, string>([['a', 'deploy']]);
    const calls: (string | undefined)[] = [];
    const runLap = vi.fn((_item: Issue, sp?: string) => {
      calls.push(sp);
      return P<LapResult>({ kind: 'SHIPPED', costUsd: 0 });
    });
    await runRalphLoop(cfg(), {
      ...deps(mockStore(['a']), runLap),
      stageLoop: stageLoopStub(store),
    });
    expect(calls).toEqual([undefined]); // no per-stage laps — just the boundary/tail lap
  });

  it('a lap that never advances the stage is retried (bounded) then escalated UNRECOVERABLE_WEDGE', async () => {
    // Seeds at `scope_write` (the pack initial); the lap keeps reporting the SAME stage → never advances.
    const runLap = vi.fn(() => P<LapResult>({ kind: 'SHIPPED', stage: 'scope_write', costUsd: 0 }));
    const r = await runRalphLoop(cfg(), {
      ...deps(mockStore(['a']), runLap),
      stageLoop: stageLoopStub(),
    });
    expect(runLap).toHaveBeenCalledTimes(10); // MAX_STAGE_RETRIES
    expect(r.parked).toEqual([{ id: 'a', reason: 'UNRECOVERABLE_WEDGE' }]);
  });

  it('a mid-stage HUMAN_REQUIRED bubbles up to the uniform park+escalate handler', async () => {
    const runLap = vi.fn(() =>
      P<LapResult>({ kind: 'HUMAN_REQUIRED', reason: 'SCOPE_FORK', costUsd: 0 }),
    );
    const r = await runRalphLoop(cfg(), {
      ...deps(mockStore(['a']), runLap),
      stageLoop: stageLoopStub(),
    });
    expect(runLap).toHaveBeenCalledTimes(1); // escalated on the first stage lap
    expect(r.parked).toEqual([{ id: 'a', reason: 'SCOPE_FORK' }]);
  });

  it('scopeGate HOLD on the only ready item → skipped (no claim/lap), loop drains to BOARD_EMPTY (no spin)', async () => {
    // GS1 corrected semantics: an unscoped item is fixed-to-scope + held, NEVER auto-redriven. When it is the
    // only ready item, the picker finds nothing automation-eligible and the loop STOPS (drained) — it must not
    // re-pick the same held item forever (the old-design spin).
    const gate = (_item: Issue): Promise<'drive' | 'hold'> => P('hold');
    const runLap = vi.fn((_item: Issue, _sp?: string) =>
      P<LapResult>({ kind: 'SHIPPED', costUsd: 0 }),
    );
    const wg = mockStore(['a']);
    const r = await runRalphLoop(cfg(), {
      ...deps(wg, runLap),
      stageLoop: stageLoopStub(new Map([['a', 'deploy']]), gate),
    });
    expect(runLap).not.toHaveBeenCalled(); // held → never claimed/driven
    expect(r.closed).toEqual([]);
    expect(r.stopped).toBe('BOARD_EMPTY'); // no automation-eligible item → drained (no spin)
  });

  it('scopeGate skips a held item and drives the NEXT eligible one (loop advances, no spin)', async () => {
    // ready = [a (held/unscoped), b (drivable)]: within the pass the gate passes OVER `a` and drives `b`; the
    // next pass has only the held `a` left → BOARD_EMPTY. `a` is never claimed/driven; the loop advanced past it.
    const gate = (item: Issue): Promise<'drive' | 'hold'> => P(item.id === 'a' ? 'hold' : 'drive');
    const driven: string[] = [];
    const runLap = vi.fn((item: Issue, _sp?: string) => {
      driven.push(item.id);
      return P<LapResult>({ kind: 'SHIPPED', costUsd: 0 });
    });
    const wg = mockStore(['a', 'b']);
    const r = await runRalphLoop(cfg(), {
      ...deps(wg, runLap),
      stageLoop: stageLoopStub(new Map([['b', 'deploy']]), gate),
    });
    expect(driven).toEqual(['b']); // only the eligible item ran; `a` was passed over
    expect(r.closed).toEqual(['b']);
    expect(r.stopped).toBe('BOARD_EMPTY'); // `a` remains held (awaits interactive scope) → drained
  });

  it('re-admission: a held item is driven on a later pass once the gate reports it scoped', async () => {
    // Model the FSM write-through re-admitting the item across passes. A second item (`b`) keeps the loop alive:
    //   pass 1 — ready=[a,b]: gate holds `a` (unscoped), drives `b` (→closed).
    //   pass 2 — ready=[a]:   the gate now reports `a` scoped (interactive human scope advanced its checkpoint +
    //                         recorded the artifact between passes) → `a` is driven (→closed).
    let aAsks = 0;
    const gate = (item: Issue): Promise<'drive' | 'hold'> => {
      if (item.id !== 'a') return P('drive'); // `b` is always eligible
      return P(++aAsks === 1 ? 'hold' : 'drive'); // `a`: held first, re-admitted after
    };
    const driven: string[] = [];
    const runLap = vi.fn((item: Issue, _sp?: string) => {
      driven.push(item.id);
      return P<LapResult>({ kind: 'SHIPPED', costUsd: 0 });
    });
    const wg = mockStore(['a', 'b']);
    const r = await runRalphLoop(cfg(), {
      ...deps(wg, runLap),
      stageLoop: stageLoopStub(
        new Map([
          ['a', 'deploy'],
          ['b', 'deploy'],
        ]),
        gate,
      ),
    });
    expect(driven).toEqual(['b', 'a']); // `a` held on pass 1 (drove `b`), re-admitted + driven on pass 2
    expect(r.closed).toEqual(['b', 'a']);
    expect(r.stopped).toBe('BOARD_EMPTY');
  });

  it('without a stageLoop driver, an item runs as ONE open-ended per-item lap (unchanged)', async () => {
    const calls: (string | undefined)[] = [];
    const runLap = vi.fn((_item: Issue, sp?: string) => {
      calls.push(sp);
      return P<LapResult>({ kind: 'SHIPPED', costUsd: 0 });
    });
    await runRalphLoop(cfg(), deps(mockStore(['a']), runLap));
    expect(calls).toEqual([undefined]); // single lap, no per-stage prompt
  });
});

// WGL.6 (wg-141e0ffd9955) — reap-then-BOARD_EMPTY: before declaring an empty board, reap orphaned stubs so junk
// never masquerades as an empty board; a genuinely-held (non-orphan) board escalates immediately.
describe('runRalphLoop — WGL.6 reap-then-BOARD_EMPTY', () => {
  const at = '2026-01-01T00:00:00.000Z';
  const mk = (over: Partial<Issue>): Issue => ({
    id: 'x',
    title: 'x',
    body: '',
    status: 'open',
    createdAt: at,
    updatedAt: at,
    ...over,
  });

  it('an all-orphan board is REAPED then escalates BOARD_EMPTY (junk never lingers); converges in one pass', async () => {
    const issues: Issue[] = [mk({ id: 'wg-orphan', body: 'sourceElementId:scope-1' })];
    const archived: string[] = [];
    const wg: WorkGraphFacade = {
      listReady: () => P([]), // nothing automation-eligible (the orphan is held by scopeGate in reality)
      listIssues: () => P(issues.map((i) => ({ ...i }))),
      listEdges: () => P([]), // no parent-child edge → the orphan is ownerless
      archiveIssue: (id: string) => {
        const it = issues.find((x) => x.id === id)!;
        it.status = 'archived'; // second reap sees it non-open → idempotent, converges
        archived.push(id);
        return P(undefined);
      },
      unarchiveIssue: () => P(undefined),
      claimIssue: () => P({ won: false, expiresAt: '' }),
      updateIssue: (id: string) => P(mk({ id })),
      wedgeMark: () => P(undefined),
      clearWedge: () => P(undefined),
      releaseClaim: () => P(undefined),
      createIssue: () => P(issues[0]!),
      getIssue: (id: string) => P(issues.find((x) => x.id === id) ?? null),
      addEdge: () => P(undefined),
      listEvents: () => P([]),
      listOpsSince: () => P([]),
      readHighWater: () => P(0),
      advanceHighWater: () => P(undefined),
    };
    const narrate = vi.fn();
    const esc = vi.fn(() => P({ escalated: true }));
    const r = await runRalphLoop(cfg(), {
      ...deps(wg, lap({ kind: 'SHIPPED', costUsd: 0 }), esc),
      narrate,
    });
    expect(r.stopped).toBe('BOARD_EMPTY');
    expect(archived).toEqual(['wg-orphan']); // reaped exactly once (idempotent → no infinite continue)
    expect(esc).toHaveBeenCalledTimes(1); // escalates only AFTER the reap
    expect(narrate).toHaveBeenCalledWith(expect.stringContaining('reaped 1 orphan'));
  });

  it('a legitimately-held board with NO orphans escalates BOARD_EMPTY immediately (reap is a no-op)', async () => {
    const held = mk({ id: 'wg-held', body: 'a genuine human ask' }); // no sourceElementId → never reaped
    const archived: string[] = [];
    const wg: WorkGraphFacade = {
      listReady: () => P([]),
      listIssues: () => P([{ ...held }]),
      listEdges: () => P([]),
      archiveIssue: (id: string) => {
        archived.push(id);
        return P(undefined);
      },
      unarchiveIssue: () => P(undefined),
      claimIssue: () => P({ won: false, expiresAt: '' }),
      updateIssue: () => P(held),
      wedgeMark: () => P(undefined),
      clearWedge: () => P(undefined),
      releaseClaim: () => P(undefined),
      createIssue: () => P(held),
      getIssue: (id: string) => P(id === held.id ? held : null),
      addEdge: () => P(undefined),
      listEvents: () => P([]),
      listOpsSince: () => P([]),
      readHighWater: () => P(0),
      advanceHighWater: () => P(undefined),
    };
    const esc = vi.fn(() => P({ escalated: true }));
    const r = await runRalphLoop(cfg(), {
      ...deps(wg, lap({ kind: 'SHIPPED', costUsd: 0 }), esc),
      narrate: vi.fn(),
    });
    expect(r.stopped).toBe('BOARD_EMPTY');
    expect(archived).toEqual([]); // the held task is NOT junk — never reaped
    expect(esc).toHaveBeenCalledTimes(1);
  });

  // #26 HWS.5(b) — the loop-pass reconcile fires once per drained pass (beside the reaper), fail-open.
  it('runs loopPassReconcile on a drained pass and narrates its nudge', async () => {
    const narrate = vi.fn();
    const reconcile = vi.fn(() => P<string | null>('🦑 out-of-session nudge'));
    const r = await runRalphLoop(cfg(), {
      ...deps(mockStore([]), lap({ kind: 'SHIPPED', costUsd: 0 })),
      narrate,
      loopPassReconcile: reconcile,
    });
    expect(r.stopped).toBe('BOARD_EMPTY');
    expect(reconcile).toHaveBeenCalled();
    expect(narrate).toHaveBeenCalledWith('🦑 out-of-session nudge');
  });

  it('a throwing loopPassReconcile never breaks the drain (fail-open, mirrors the reaper)', async () => {
    const r = await runRalphLoop(cfg(), {
      ...deps(mockStore([]), lap({ kind: 'SHIPPED', costUsd: 0 })),
      narrate: vi.fn(),
      loopPassReconcile: () => Promise.reject(new Error('reconcile down')),
    });
    expect(r.stopped).toBe('BOARD_EMPTY'); // the pass still completes
  });
});

describe('runRalphLoop — AGF.3 worktree pool attachment (wg-4ae1004c931b)', () => {
  it('drives the claimed item in its own worktree (add before drive, remove after) + still closes SHIPPED', async () => {
    const added: string[] = [];
    const removed: string[] = [];
    const io = {
      worktreeAdd: (_b: string, path: string) => {
        added.push(path);
        return P(undefined);
      },
      worktreeRemove: (path: string) => {
        removed.push(path);
        return P(undefined);
      },
    };
    const wg = mockStore(['a']);
    const r = await runRalphLoop(cfg(), {
      ...deps(wg, lap({ kind: 'SHIPPED', costUsd: 0 })),
      pool: { bound: 2, poolRoot: '/pool', mainRoot: '/main', io },
    });
    expect(added).toEqual(['/pool/a']); // worktree cut for the item
    expect(removed).toEqual(['/pool/a']); // torn down after the drive
    expect(r.closed).toContain('a'); // fold semantics preserved — SHIPPED still closes
  });

  it('tears down the worktree even when the drive throws (fail-open finally)', async () => {
    const removed: string[] = [];
    const io = {
      worktreeAdd: () => P(undefined),
      worktreeRemove: (path: string) => {
        removed.push(path);
        return P(undefined);
      },
    };
    const wg = mockStore(['a']);
    await runRalphLoop(cfg(), {
      ...deps(
        wg,
        vi.fn(() => Promise.reject(new Error('lap boom'))),
      ),
      supervise: {
        maxRetries: 0,
        backoffMs: () => 0,
        heartbeat: () => undefined,
        sleep: () => P(undefined),
      },
      pool: { bound: 1, poolRoot: '/pool', mainRoot: '/main', io },
    } as never);
    expect(removed).toEqual(['/pool/a']); // torn down despite the throw
  });
});
