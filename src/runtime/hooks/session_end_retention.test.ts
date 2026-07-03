/**
 * #16 — tests for the retention-sweep gate WIRING (design: v2-scope-clarifications-2026-07-01.md:150).
 *
 * The destructive 30-day sweep (`backend.sweepRetired`) must run ONLY when the #16 prune gate allows it.
 * These assert the seam that `session-end.ts` uses:
 *   - gate=true  → sweepRetired called (with the correct 30-day cutoff), swept ids returned.
 *   - gate=false → sweepRetired NOT called (returns []; the destructive delete is skipped).
 *   - gate throws → propagates; sweepRetired NOT called. `session-end.ts`'s existing try/catch turns this
 *     into a logged skip + completed teardown (fail-open) — verified by contract, not duplicated here.
 *
 * Pure injected deps (stub gate + fake clock + fake backend) — no libSQL / no git / no OPENSQUID_HOME.
 * Mirrors session_end_sweep_notify.test.ts (RSW.2): inject the seams, assert the call sites.
 */
import { describe, expect, it } from 'vitest';

import {
  RETENTION_WINDOW_MS,
  sweepRetiredIfAllowed,
  type RetentionSweepBackend,
} from './session_end_retention.js';

const CWD = '/x/proj';
const NOW = Date.UTC(2026, 6, 3); // fixed clock → deterministic cutoff

/** Fake backend recording the cutoff it was swept with; returns `ids`. */
function fakeBackend(ids: string[]): { calls: string[]; backend: RetentionSweepBackend } {
  const calls: string[] = [];
  return {
    calls,
    backend: {
      sweepRetired: (cutoffIso: string) => {
        calls.push(cutoffIso);
        return Promise.resolve(ids);
      },
    },
  };
}

const allow = (): Promise<boolean> => Promise.resolve(true);
const deny = (): Promise<boolean> => Promise.resolve(false);

describe('sweepRetiredIfAllowed (#16 gate wiring)', () => {
  it('gate=true → sweepRetired called with the 30-day cutoff; swept ids returned', async () => {
    const { calls, backend } = fakeBackend(['a', 'b']);

    const swept = await sweepRetiredIfAllowed(backend, CWD, { pruneAllowed: allow, now: () => NOW });

    expect(swept).toEqual(['a', 'b']);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(new Date(NOW - RETENTION_WINDOW_MS).toISOString());
  });

  it('gate=false → sweepRetired NOT called; destructive sweep skipped (returns [])', async () => {
    const { calls, backend } = fakeBackend(['a', 'b']);

    const swept = await sweepRetiredIfAllowed(backend, CWD, { pruneAllowed: deny, now: () => NOW });

    expect(swept).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('gate throws → propagates (session-end try/catch keeps teardown fail-open); sweep NOT called', async () => {
    const { calls, backend } = fakeBackend(['a']);
    const throwing = (): Promise<boolean> => Promise.reject(new Error('gate boom'));

    await expect(
      sweepRetiredIfAllowed(backend, CWD, { pruneAllowed: throwing, now: () => NOW }),
    ).rejects.toThrow('gate boom');
    expect(calls).toHaveLength(0);
  });

  it('gate=true but backend has no sweepRetired → returns [] (optional method absent)', async () => {
    const swept = await sweepRetiredIfAllowed({}, CWD, { pruneAllowed: allow, now: () => NOW });
    expect(swept).toEqual([]);
  });
});
