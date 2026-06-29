/**
 * DBL.1b — the deploy-verification record (mirrors readiness's record/read). Sandboxes OPENSQUID_HOME per test.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { recordVerification, readVerification } from './verification.js';

let home: string;
let prior: string | undefined;
const SID = 'sess-verify';

beforeEach(async () => {
  prior = process.env.OPENSQUID_HOME;
  home = await mkdtemp(join(tmpdir(), 'opensquid-verify-'));
  process.env.OPENSQUID_HOME = home;
});
afterEach(async () => {
  if (prior === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = prior;
  await rm(home, { recursive: true, force: true });
});

describe('verification record (DBL.1b)', () => {
  it('absent → null (never run; the caller decides skip-vs-fail-closed)', async () => {
    expect(await readVerification(SID, 't1')).toBeNull();
  });

  it('record(true) → read true; record(false) → read false (latest-verify-wins)', async () => {
    await recordVerification(SID, 't1', true);
    expect(await readVerification(SID, 't1')).toBe(true);
    await recordVerification(SID, 't1', false); // a re-run after a regression overwrites
    expect(await readVerification(SID, 't1')).toBe(false);
  });

  it('is per-task (one task\'s result does not leak to another)', async () => {
    await recordVerification(SID, 't1', true);
    expect(await readVerification(SID, 't2')).toBeNull();
  });
});
