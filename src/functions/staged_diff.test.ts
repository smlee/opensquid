/**
 * Tests for `stagedDiff` (GFR.1c) — the CODE audit artifact (uncommitted diff). Pure over injected readers (no
 * git, no fs): asserts the content path + the FAIL-LOUD null paths (no cwd / empty / git error / over-cap).
 */
import { describe, expect, it } from 'vitest';

import { stagedDiff, type DiffDeps } from './staged_diff.js';

const deps = (over: Partial<DiffDeps> = {}): DiffDeps => ({
  cwd: async () => '/repo',
  run: async () => 'diff --git a/x b/x\n@@ -1 +1 @@\n+added line\n',
  ...over,
});

describe('stagedDiff', () => {
  it('returns the diff content', async () => {
    const d = await stagedDiff('s', deps());
    expect(d).toContain('+added line');
  });

  it('returns null (fail-loud) on no cwd / empty diff / git error', async () => {
    await expect(stagedDiff('s', deps({ cwd: async () => null }))).resolves.toBeNull();
    await expect(stagedDiff('s', deps({ run: async () => '   \n' }))).resolves.toBeNull();
    await expect(
      stagedDiff(
        's',
        deps({
          run: async () => {
            throw new Error('git fail');
          },
        }),
      ),
    ).resolves.toBeNull();
  });

  it('returns null when over-cap (never a partial/truncated diff)', async () => {
    const huge = 'x'.repeat(200_001);
    await expect(stagedDiff('s', deps({ run: async () => huge }))).resolves.toBeNull();
  });
});
