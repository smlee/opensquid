/**
 * #16 — tests for the retention-prune GATE (design: v2-scope-clarifications-2026-07-01.md:150).
 *
 * The prune runs ONLY when BOTH hold: the cwd project's work-graph cycle is complete
 * (open+in_progress === 0) AND the git working tree is clean. FAIL-CLOSED on any uncertainty.
 *
 * Pure injected deps (no libSQL / no git / no OPENSQUID_HOME) — the two signals are stubbed so the
 * predicate's decision logic is asserted deterministically.
 */
import { describe, expect, it } from 'vitest';

import { retentionPruneAllowed, type PruneGateDeps } from './session_end_prune_gate.js';

const CWD = '/x/proj';

function deps(open: number, clean: boolean): PruneGateDeps {
  return {
    openWorkCount: () => Promise.resolve(open),
    gitClean: () => Promise.resolve(clean),
  };
}

describe('retentionPruneAllowed (#16 cycle-complete AND committed gate)', () => {
  it('sweeps when the cycle is complete AND the tree is clean', async () => {
    expect(await retentionPruneAllowed(CWD, deps(0, true))).toBe(true);
  });

  it('does NOT sweep when an open/in_progress issue remains (cycle incomplete)', async () => {
    expect(await retentionPruneAllowed(CWD, deps(1, true))).toBe(false);
  });

  it('does NOT sweep when the working tree is dirty (uncommitted)', async () => {
    expect(await retentionPruneAllowed(CWD, deps(0, false))).toBe(false);
  });

  it('does NOT sweep when BOTH conditions fail', async () => {
    expect(await retentionPruneAllowed(CWD, deps(3, false))).toBe(false);
  });

  it('FAILS CLOSED when the work-graph read throws (uncertain → no prune)', async () => {
    const throwing: PruneGateDeps = {
      openWorkCount: () => Promise.reject(new Error('db unreachable')),
      gitClean: () => Promise.resolve(true),
    };
    expect(await retentionPruneAllowed(CWD, throwing)).toBe(false);
  });

  it('FAILS CLOSED when the git check throws (e.g. not a repo → no prune)', async () => {
    const throwing: PruneGateDeps = {
      openWorkCount: () => Promise.resolve(0),
      gitClean: () => Promise.reject(new Error('not a git repository')),
    };
    expect(await retentionPruneAllowed(CWD, throwing)).toBe(false);
  });

  it('short-circuits: an incomplete cycle skips the git read entirely', async () => {
    let gitCalled = false;
    const d: PruneGateDeps = {
      openWorkCount: () => Promise.resolve(2),
      gitClean: () => {
        gitCalled = true;
        return Promise.resolve(true);
      },
    };
    expect(await retentionPruneAllowed(CWD, d)).toBe(false);
    expect(gitCalled).toBe(false);
  });
});
