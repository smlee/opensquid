import { describe, it, expect, vi } from 'vitest';
import { runRalphLoop, resolveParked, type RalphConfig, type RalphDeps } from './orchestrator.js';
import type { Issue, WorkGraphFacade } from '../../workgraph/types.js';
import type { LapResult } from './supervisor.js';

const P = <T>(v: T): Promise<T> => Promise.resolve(v);

// ---- minimal in-memory work-graph: just the surface runRalphLoop touches ----
// listReady returns open, non-wedged, non-live-claimed items oldest-first; claim/close/wedge mutate
// state so the loop terminates naturally (the real store's invariants, in miniature).
function mockStore(ids: string[], claimLost = new Set<string>()): WorkGraphFacade {
  const rows = new Map<string, { status: 'open' | 'closed'; wedged: boolean; claimed: boolean }>();
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
    listEvents: () => P([]),
    listEdges: () => P([]),
  };
  return store;
}

const cfg = (over: Partial<RalphConfig> = {}): RalphConfig => ({
  authMode: 'subscription',
  maxBudgetUsd: 100,
  claimTtlSec: 1800,
  once: false,
  supervise: {
    maxRetries: 0,
    backoffMs: () => 0,
    heartbeat: () => undefined,
    sleep: () => P(undefined),
  },
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

  it('one ready item, lap SHIPPED → item closed, loop ends (--once)', async () => {
    const runLap = lap({ kind: 'SHIPPED', costUsd: 0.04 });
    const r = await runRalphLoop(cfg({ once: true }), deps(mockStore(['a']), runLap));
    expect(r.stopped).toBe('once');
    expect(r.closed).toEqual(['a']);
    expect(r.parked).toEqual([]);
    expect(r.spent).toBeCloseTo(0.04);
  });

  it('T2.9: calls onShipped(taskId) after a SHIPPED lap (the loop-driver live caller)', async () => {
    const runLap = lap({ kind: 'SHIPPED', costUsd: 0 });
    const onShipped = vi.fn(() => P(undefined));
    await runRalphLoop(cfg({ once: true }), {
      ...deps(mockStore(['a']), runLap),
      onShipped,
    });
    expect(onShipped).toHaveBeenCalledWith('a');
  });

  it('T2.9: a throwing onShipped does NOT break the drain — the item still closes (fail-open)', async () => {
    const runLap = lap({ kind: 'SHIPPED', costUsd: 0 });
    const onShipped = vi.fn(() => Promise.reject(new Error('report boom')));
    const r = await runRalphLoop(cfg({ once: true }), {
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
      cfg({ authMode: 'api', maxBudgetUsd: 1, once: false }),
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

  it('undroppable escalation: a failed delivery throws (no silent drop)', async () => {
    const runLap = lap({ kind: 'SHIPPED', costUsd: 0 });
    const failEsc = vi.fn(() => P({ escalated: false, reason: 'no channel' }));
    await expect(runRalphLoop(cfg(), deps(mockStore([]), runLap, failEsc))).rejects.toThrow(
      /UNDELIVERABLE/,
    );
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
const AUTOMATED = new Set(['scope_write', 'plan', 'author', 'code']);
/** A stageLoop driver over an in-memory durable-stage store; stagePrompt = `DO <stage>` (the test reads it back). */
function stageLoopStub(
  store = new Map<string, string>(),
): NonNullable<RalphDeps['stageLoop']> {
  return {
    initialStage: 'scope',
    isAutomated: (s: string) => AUTOMATED.has(s),
    stagePrompt: (_item: Issue, stage: string) => P(`DO ${stage}`),
    readStage: (id: string) => P(store.get(id) ?? null),
    writeStage: (id: string, s: string) => {
      store.set(id, s);
      return P(undefined);
    },
    clearStage: (id: string) => {
      store.delete(id);
      return P(undefined);
    },
  };
}

describe('runRalphLoop — PSL.3 per-stage loop', () => {
  it('drives each automated stage as its own lap (advancing via the reported stage), then the boundary lap', async () => {
    // GS1: scope is now a HUMAN-BOUNDARY (interactive) lap; scope_write is the first AUTOMATED stage.
    // Flow: scope (human, advances to scope_write) → scope_write/plan/author/code (automated) → deploy (human, done)
    const advance: Record<string, string> = {
      scope_write: 'plan',
      plan: 'author',
      author: 'code',
      code: 'deploy',
    };
    const calls: (string | undefined)[] = [];
    const store = new Map<string, string>();
    let humanLapCount = 0;
    const runLap = vi.fn((_item: Issue, sp?: string) => {
      calls.push(sp);
      if (sp === undefined) {
        humanLapCount++;
        if (humanLapCount === 1) {
          // The interactive scope lap: confirms with user, advances to scope_write.
          return P<LapResult>({ kind: 'SHIPPED', stage: 'scope_write', costUsd: 0.01 });
        }
        // The deploy/accept boundary lap: no stage = item complete.
        return P<LapResult>({ kind: 'SHIPPED', costUsd: 0.01 });
      }
      const next = advance[sp.replace('DO ', '')];
      return P<LapResult>(
        next === undefined ? { kind: 'SHIPPED', costUsd: 0.01 } : { kind: 'SHIPPED', stage: next, costUsd: 0.01 },
      );
    });
    const r = await runRalphLoop(cfg({ once: true }), {
      ...deps(mockStore(['a']), runLap),
      stageLoop: stageLoopStub(store),
    });
    // 1 human scope lap + 4 automated laps (scope_write/plan/author/code) + 1 human deploy lap = 6
    expect(calls).toEqual([undefined, 'DO scope_write', 'DO plan', 'DO author', 'DO code', undefined]);
    expect(r.closed).toEqual(['a']);
    expect(r.spent).toBeCloseTo(0.06);
    expect(store.has('a')).toBe(false); // clearStage on close
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
        next === undefined ? { kind: 'SHIPPED', costUsd: 0 } : { kind: 'SHIPPED', stage: next, costUsd: 0 },
      );
    });
    await runRalphLoop(cfg({ once: true }), {
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
    await runRalphLoop(cfg({ once: true }), {
      ...deps(mockStore(['a']), runLap),
      stageLoop: stageLoopStub(store),
    });
    expect(calls).toEqual([undefined]); // no per-stage laps — just the boundary/tail lap
  });

  it('a lap that never advances the stage is retried (bounded) then escalated UNRECOVERABLE_WEDGE', async () => {
    const runLap = vi.fn(() => P<LapResult>({ kind: 'SHIPPED', stage: 'scope', costUsd: 0 })); // never advances
    const r = await runRalphLoop(cfg({ once: true }), {
      ...deps(mockStore(['a']), runLap),
      stageLoop: stageLoopStub(),
    });
    expect(runLap).toHaveBeenCalledTimes(3); // MAX_STAGE_RETRIES
    expect(r.parked).toEqual([{ id: 'a', reason: 'UNRECOVERABLE_WEDGE' }]);
  });

  it('a mid-stage HUMAN_REQUIRED bubbles up to the uniform park+escalate handler', async () => {
    const runLap = vi.fn(() =>
      P<LapResult>({ kind: 'HUMAN_REQUIRED', reason: 'SCOPE_FORK', costUsd: 0 }),
    );
    const r = await runRalphLoop(cfg({ once: true }), {
      ...deps(mockStore(['a']), runLap),
      stageLoop: stageLoopStub(),
    });
    expect(runLap).toHaveBeenCalledTimes(1); // escalated on the first stage lap
    expect(r.parked).toEqual([{ id: 'a', reason: 'SCOPE_FORK' }]);
  });

  it('without a stageLoop driver, an item runs as ONE open-ended per-item lap (unchanged)', async () => {
    const calls: (string | undefined)[] = [];
    const runLap = vi.fn((_item: Issue, sp?: string) => {
      calls.push(sp);
      return P<LapResult>({ kind: 'SHIPPED', costUsd: 0 });
    });
    await runRalphLoop(cfg({ once: true }), deps(mockStore(['a']), runLap));
    expect(calls).toEqual([undefined]); // single lap, no per-stage prompt
  });
});
