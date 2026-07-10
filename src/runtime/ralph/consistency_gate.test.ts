import { describe, it, expect } from 'vitest';
import {
  durableItemCommitExists,
  MAX_COMMIT_REDRIVES,
  NO_DURABLE_COMMIT_LABEL,
  type RalphGitSeam,
} from './consistency_gate.js';

// CG.2 — the PURE-predicate matrix over a scripted RalphGitSeam (no real git, no `.opensquid` I/O). Because
// `durableItemCommitExists` takes `baseSha` as an explicit arg, the seam's `tip`/`committed`/`dirty` are plain
// constants here — the orchestrator wiring (baseSha := git.tip() before the drive) is covered in orchestrator.test.ts.
const seam = (o: { tip: string; committed: string[]; dirty: string[] }): RalphGitSeam => ({
  tip: () => Promise.resolve(o.tip),
  committedSince: () => Promise.resolve(o.committed),
  uncommittedPaths: () => Promise.resolve(o.dirty),
});

// GF.2 — a seam that CAPTURES the ref each read is called with, and returns per-ref scripted tip/committed,
// proving `durableItemCommitExists(git, base, targetRef)` forwards the CONFIGURED integration target to the seam.
const refSeam = (
  byRef: Record<string, { tip: string; committed: string[] }>,
  dirty: string[] = [],
): { git: RalphGitSeam; refs: (string | undefined)[] } => {
  const refs: (string | undefined)[] = [];
  const at = (ref?: string) => byRef[ref ?? 'HEAD'] ?? { tip: 'MISSING', committed: [] };
  return {
    refs,
    git: {
      tip: (ref) => (refs.push(ref), Promise.resolve(at(ref).tip)),
      committedSince: (_base, ref) => Promise.resolve(at(ref).committed),
      uncommittedPaths: () => Promise.resolve(dirty),
    },
  };
};

describe('durableItemCommitExists — GF.2 config-target-aware (targetRef forwarding)', () => {
  const BASE = 'base000';
  it('targetRef given → reads the target branch tip/committed (landed on target → true)', async () => {
    const s = refSeam({
      stage: { tip: 'stagetip', committed: ['a.ts'] },
      HEAD: { tip: BASE, committed: [] },
    });
    expect(await durableItemCommitExists(s.git, BASE, 'stage')).toBe(true);
    // the predicate forwarded `stage` to BOTH reads (never defaulted to HEAD)
    expect(s.refs).toEqual(['stage']);
  });
  it('targetRef given, target not advanced → false (missing durable target commit → the existing park)', async () => {
    const s = refSeam({ stage: { tip: BASE, committed: [] } });
    expect(await durableItemCommitExists(s.git, BASE, 'stage')).toBe(false);
  });
  it('targetRef OMITTED → HEAD (byte-identical to the shipped base gate)', async () => {
    const s = refSeam({ HEAD: { tip: 'headtip', committed: ['a.ts'] } });
    expect(await durableItemCommitExists(s.git, BASE)).toBe(true);
    expect(s.refs).toEqual([undefined]);
  });
});

describe('consistency_gate — constants', () => {
  it('MAX_COMMIT_REDRIVES is a small bound (2), NOT MAX_STAGE_RETRIES (10)', () => {
    expect(MAX_COMMIT_REDRIVES).toBe(2);
  });
  it('NO_DURABLE_COMMIT_LABEL is the surfaced park reason string', () => {
    expect(NO_DURABLE_COMMIT_LABEL).toBe('no-durable-commit');
  });
});

describe('durableItemCommitExists', () => {
  const BASE = 'base000';

  it('commit landed, clean → true', async () =>
    expect(
      await durableItemCommitExists(seam({ tip: 'tip111', committed: ['a.ts'], dirty: [] }), BASE),
    ).toBe(true));

  it('tip unmoved → false (the reporting-item headline shape)', async () =>
    expect(
      await durableItemCommitExists(seam({ tip: BASE, committed: [], dirty: ['a.ts'] }), BASE),
    ).toBe(false));

  it('tip unmoved but committedSince non-empty (impossible in real git, defensively guarded by the tip clause) → false', async () =>
    // A diff against an unmoved tip is empty in real git; guard belt-and-suspenders — tip===base ⇒ not advanced.
    expect(
      await durableItemCommitExists(seam({ tip: BASE, committed: ['a.ts'], dirty: [] }), BASE),
    ).toBe(false));

  it('empty commit (tip moved, nothing committed) → false', async () =>
    expect(
      await durableItemCommitExists(seam({ tip: 'tip111', committed: [], dirty: [] }), BASE),
    ).toBe(false));

  it('committed file left dirty (partial commit — same file still staged/unstaged) → false', async () =>
    expect(
      await durableItemCommitExists(
        seam({ tip: 'tip111', committed: ['a.ts'], dirty: ['a.ts'] }),
        BASE,
      ),
    ).toBe(false));

  it('one of several committed files left dirty → false (every committed file must be clean)', async () =>
    expect(
      await durableItemCommitExists(
        seam({ tip: 'tip111', committed: ['a.ts', 'b.ts'], dirty: ['b.ts'] }),
        BASE,
      ),
    ).toBe(false));

  it('drive-by dirt (dirty paths DISJOINT from the committed set) → true (tolerated, not folded in)', async () =>
    expect(
      await durableItemCommitExists(
        seam({ tip: 'tip111', committed: ['a.ts'], dirty: ['unrelated.ts'] }),
        BASE,
      ),
    ).toBe(true));
});
