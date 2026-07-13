/**
 * write_lane — the LANE MODEL decision layer (the #33 successor to advance-action detection).
 *
 * Proves the five cases of `evaluateLane` + the `matchesLane`/`extractWritePath` helpers: a laneless stage is
 * INERT, reads never block, a Bash mutation is not lane-checked (orchestrator-guard's concern), an in-lane
 * file-write passes, and an out-of-lane file-write is the blockable case. Repo-relative globs match absolute
 * paths (the live tool-call shape).
 */
import { describe, expect, it } from 'vitest';

import { evaluateLane, extractWritePath, laneBlockMessage, matchesLane } from './write_lane.js';

describe('matchesLane', () => {
  it('matches a repo-relative glob against a relative AND an absolute path (** anchor)', () => {
    expect(
      matchesLane('docs/research/T-x-pre-research-2026.md', ['docs/research/*pre-research*']),
    ).toBe(true);
    expect(
      matchesLane('/tmp/repo/docs/research/T-x-pre-research-2026.md', [
        'docs/research/*pre-research*',
      ]),
    ).toBe(true);
    expect(matchesLane('/repo/src/a/b.ts', ['src/**'])).toBe(true);
  });

  it('does NOT match a filename-scoped lane on a non-artifact file in the same dir', () => {
    expect(matchesLane('docs/research/some-notes.md', ['docs/research/*pre-research*'])).toBe(
      false,
    );
  });

  it('does NOT match a path outside the lane', () => {
    expect(matchesLane('/tmp/repo/src/foo.ts', ['docs/research/**'])).toBe(false);
  });

  it('the `**` lane matches every path (an explicitly-unrestricted stage)', () => {
    expect(matchesLane('src/deep/nested/x.ts', ['**'])).toBe(true);
    expect(matchesLane('/abs/anything.json', ['**'])).toBe(true);
  });

  it('empty globs match nothing', () => {
    expect(matchesLane('anything', [])).toBe(false);
  });
});

describe('extractWritePath', () => {
  it('reads file_path from Write/Edit and notebook_path from NotebookEdit', () => {
    expect(extractWritePath('Write', { file_path: 'src/a.ts' })).toBe('src/a.ts');
    expect(extractWritePath('Edit', { file_path: 'src/b.ts' })).toBe('src/b.ts');
    expect(extractWritePath('MultiEdit', { file_path: 'src/c.ts' })).toBe('src/c.ts');
    expect(extractWritePath('NotebookEdit', { notebook_path: 'nb.ipynb' })).toBe('nb.ipynb');
  });

  it('returns null for a Bash mutation (no single file path) and for reads', () => {
    expect(extractWritePath('Bash', { command: 'sed -i s/a/b/ f' })).toBeNull();
    expect(extractWritePath('Read', { file_path: 'src/a.ts' })).toBeNull();
    expect(extractWritePath('Write', {})).toBeNull();
  });
});

describe('evaluateLane — the five cases', () => {
  const lane = ['docs/research/*pre-research*'];

  it('no lane declared → INERT (checked:false), even for a mutating write', () => {
    expect(evaluateLane(undefined, 'Write', { file_path: 'src/x.ts' })).toEqual({
      checked: false,
      path: null,
      outOfLane: false,
    });
    expect(evaluateLane([], 'Write', { file_path: 'src/x.ts' }).checked).toBe(false);
  });

  it('a read → never blocks (checked:false)', () => {
    expect(evaluateLane(lane, 'Read', { file_path: 'src/x.ts' }).checked).toBe(false);
    expect(evaluateLane(lane, 'Grep', { pattern: 'x' }).checked).toBe(false);
  });

  it('a Bash mutation → NOT lane-checked here (orchestrator-guard owns shell mutations)', () => {
    expect(evaluateLane(lane, 'Bash', { command: "sed -i 's/a/b/' src/x.ts" }).checked).toBe(false);
  });

  it('an IN-lane file-write → checked, NOT out of lane', () => {
    const v = evaluateLane(lane, 'Write', { file_path: 'docs/research/T-x-pre-research-2026.md' });
    expect(v).toEqual({
      checked: true,
      path: 'docs/research/T-x-pre-research-2026.md',
      outOfLane: false,
    });
  });

  it('an OUT-of-lane file-write → checked + outOfLane (the blockable case)', () => {
    const v = evaluateLane(lane, 'Write', { file_path: 'src/foo.ts' });
    expect(v).toEqual({ checked: true, path: 'src/foo.ts', outOfLane: true });
  });
});

describe('laneBlockMessage', () => {
  it('names the stage, the offending path, and the allowed lane', () => {
    const msg = laneBlockMessage('scope', 'src/foo.ts', ['docs/research/*pre-research*']);
    expect(msg).toContain('scope');
    expect(msg).toContain('src/foo.ts');
    expect(msg).toContain('docs/research/*pre-research*');
    expect(msg).toContain('out of lane');
  });
});
