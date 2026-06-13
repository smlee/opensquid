import { describe, it, expect, vi } from 'vitest';
import { runRalphLoop, type RalphConfig, type RalphDeps } from './orchestrator.js';
import type { Issue, WorkGraphStore } from '../../workgraph/types.js';
import type { LapResult } from './supervisor.js';

const P = <T>(v: T): Promise<T> => Promise.resolve(v);

// ---- minimal in-memory work-graph: just the surface runRalphLoop touches ----
// listReady returns open, non-wedged, non-live-claimed items oldest-first; claim/close/wedge mutate
// state so the loop terminates naturally (the real store's invariants, in miniature).
function mockStore(ids: string[], claimLost = new Set<string>()): WorkGraphStore {
  const rows = new Map<string, { status: 'open' | 'closed'; wedged: boolean; claimed: boolean }>();
  ids.forEach((id) => rows.set(id, { status: 'open', wedged: false, claimed: false }));
  const issue = (id: string): Issue => ({
    id,
    title: id,
    body: '',
    status: rows.get(id)!.status,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  const store: WorkGraphStore = {
    listReady: () =>
      P(ids.filter((id) => { const r = rows.get(id)!; return r.status === 'open' && !r.wedged && !r.claimed; }).map(issue)),
    claimIssue: (id: string) => {
      rows.get(id)!.claimed = true; // either way it now carries a live claim → excluded next pass
      return P(claimLost.has(id) ? { won: false, expiresAt: '' } : { won: true, expiresAt: '2026-01-01T00:30:00.000Z' });
    },
    updateIssue: (id: string, patch: { status?: 'open' | 'closed' }) => {
      if (patch.status) rows.get(id)!.status = patch.status;
      return P(issue(id));
    },
    wedgeMark: (id: string) => { rows.get(id)!.wedged = true; return P(undefined); },
    // unused by the loop — present to satisfy the interface
    init: () => P(undefined),
    createIssue: () => P(issue(ids[0] ?? 'x')),
    getIssue: (id: string) => P(rows.has(id) ? issue(id) : null),
    listIssues: () => P(ids.map(issue)),
    addEdge: () => P(undefined),
    listEvents: () => P([]),
  };
  return store;
}

const cfg = (over: Partial<RalphConfig> = {}): RalphConfig => ({
  authMode: 'subscription',
  maxBudgetUsd: 100,
  claimTtlSec: 1800,
  once: false,
  supervise: { maxRetries: 0, backoffMs: () => 0, heartbeat: () => undefined, sleep: () => P(undefined) },
  ...over,
});

const deps = (
  wg: WorkGraphStore,
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

  it('lap-emitted RATE_BUDGET (resource pause) → escalate + STOP, item parked', async () => {
    const runLap = lap({ kind: 'HUMAN_REQUIRED', reason: 'RATE_BUDGET', costUsd: 0.01 });
    const r = await runRalphLoop(cfg(), deps(mockStore(['a', 'b']), runLap));
    expect(r.stopped).toBe('RATE_BUDGET');
    expect(r.parked).toEqual([{ id: 'a', reason: 'RATE_BUDGET' }]);
  });

  it('undroppable escalation: a failed delivery throws (no silent drop)', async () => {
    const runLap = lap({ kind: 'SHIPPED', costUsd: 0 });
    const failEsc = vi.fn(() => P({ escalated: false, reason: 'no channel' }));
    await expect(runRalphLoop(cfg(), deps(mockStore([]), runLap, failEsc))).rejects.toThrow(/UNDELIVERABLE/);
  });
});
