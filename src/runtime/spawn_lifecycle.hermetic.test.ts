/**
 * T-spawn-lifecycle-hermetic-tests SLH.4 (wg-23fd463ab434) — the durable teeth
 * on the acceptance: a static guard that reads spawn_lifecycle.test.ts source
 * and asserts the CI-flake tokens are ABSENT, so a future edit re-introducing a
 * temp-folder / real-spawn / wall-clock-wait test FAILS the always-on suite —
 * the flake class (a fixed `waitMs(N)` racing a real spawn-chain + file-write on
 * a loaded runner → ENOENT) can never silently return.
 *
 * Scopes ONLY the unit file. The genuine real-process check legitimately keeps
 * its temp fixture + wall-clock wait, but it lives in the opt-in e2e file
 * (test/e2e/spawn-lifecycle.e2e.test.ts), off the always-on path — not here.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const UNIT = fileURLToPath(new URL('./spawn_lifecycle.test.ts', import.meta.url));
const src = readFileSync(UNIT, 'utf8');

// temp-folder / real-spawn / wall-clock-wait tokens — the structural causes of the flake, not `insideSupervisedTree`.
const FORBIDDEN: [string, RegExp][] = [
  ['mkdtemp', /mkdtemp/],
  ['tmpdir', /tmpdir/],
  ['node:fs/promises', /node:fs\/promises/],
  ['node:child_process spawn', /node:child_process/],
  ['wall-clock waitMs(', /\bwaitMs\s*\(/],
];

describe('spawn_lifecycle.test.ts stays hermetic (the CI-flake guard)', () => {
  it.each(FORBIDDEN)(
    'does not use %s (no temp-folder / real-spawn / wall-clock wait)',
    (_label, re) => {
      expect(re.test(src)).toBe(false); // a re-introduced real-spawn / temp-folder test fails the always-on suite
    },
  );
});
